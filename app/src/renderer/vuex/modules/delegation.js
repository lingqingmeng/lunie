import { calculateTokens } from "scripts/common"
export default ({ node }) => {
  let emptyState = {
    loading: false,
    loadedOnce: false,

    // our delegations, maybe not yet committed
    delegates: [],

    // our delegations which are already on the blockchain
    committedDelegates: {},
    unbondingDelegations: {}
  }
  const state = JSON.parse(JSON.stringify(emptyState))

  // Staking Msgs
  const msgDelegation = "delegation"
  // const msgBeginUnbonding = "begin_unbonding"
  // const msgCompleteUnbonding = "complete_unbonding"
  // const msgBeginRedelegation = "begin_redelegation"
  // const msgCompleteRedelegation = "complete_redelegation"

  const mutations = {
    addToCart(state, delegate) {
      // don't add to cart if already in cart
      for (let existingDelegate of state.delegates) {
        if (delegate.id === existingDelegate.id) return
      }

      state.delegates.push({
        id: delegate.id,
        delegate: Object.assign({}, delegate),
        atoms: 0
      })
    },
    removeFromCart(state, delegate) {
      state.delegates = state.delegates.filter(c => c.id !== delegate)
    },
    setShares(state, { candidateId, value }) {
      state.delegates.find(c => c.id === candidateId).atoms = value
    },
    setCommittedDelegation(state, { candidateId, value }) {
      let committedDelegates = Object.assign({}, state.committedDelegates)
      if (value === 0) {
        delete committedDelegates[candidateId]
      } else {
        committedDelegates[candidateId] = value
      }
      state.committedDelegates = committedDelegates
    },
    setUnbondingDelegations(state, { validator_addr, min_time, balance }) {
      let unbondingDelegations = Object.assign({}, state.unbondingDelegations)
      if (balance.amount === 0) {
        delete unbondingDelegations[validator_addr]
      } else {
        unbondingDelegations[validator_addr] = { min_time, balance }
      }
      state.unbondingDelegations = unbondingDelegations
    },
    setDelegatorValidators(state, validators) {
      state.myDelegates = validators
    }
  }

  let actions = {
    reconnected({ state, dispatch }) {
      if (state.loading) {
        dispatch("getBondedDelegates")
      }
    },
    resetSessionData({ rootState }) {
      rootState.delegation = JSON.parse(JSON.stringify(emptyState))
    },
    // load committed delegations from LCD
    async getBondedDelegates(
      { state, rootState, commit, dispatch },
      candidates
    ) {
      state.loading = true
      let address = rootState.user.address
      candidates = candidates || (await dispatch("getDelegates"))

      let delegator = await node.getDelegator(address)
      // the request runs that long, that the user might sign out and back in again
      // the result is, that the new users state gets updated by the old users request
      // here we check if the user is still the same
      if (rootState.user.address !== address) return

      if (delegator.delegations) {
        delegator.delegations.forEach(({ validator_addr, shares }) => {
          commit("setCommittedDelegation", {
            candidateId: validator_addr,
            value: parseFloat(shares)
          })
          if (shares > 0) {
            const delegate = candidates.find(
              ({ owner }) => owner === validator_addr // this should change to address instead of owner
            )
            commit("addToCart", delegate)
          }
        })
      }
      // delete delegations not present anymore
      Object.keys(state.committedDelegates).forEach(validatorAddr => {
        if (
          !delegator.delegations ||
          !delegator.delegations.find(
            ({ validator_addr }) => validator_addr === validatorAddr
          )
        )
          commit("setCommittedDelegation", {
            candidateId: validatorAddr,
            value: 0
          })
      })

      if (delegator.unbonding_delegations) {
        delegator.unbonding_delegations.forEach(
          ({ validator_addr, balance, min_time }) => {
            commit("setUnbondingDelegations", {
              validator_addr,
              balance,
              min_time
            })
          }
        )
      }
      // delete undelegations not present anymore
      Object.keys(state.unbondingDelegations).forEach(validatorAddr => {
        if (
          !delegator.unbonding_delegations ||
          !delegator.unbonding_delegations.find(
            ({ validator_addr }) => validator_addr === validatorAddr
          )
        )
          commit("setUnbondingDelegations", {
            validator_addr: validatorAddr,
            balance: { amount: 0 }
          })
      })

      state.loadedOnce = true
      state.loading = false
    },
    async updateDelegates({ dispatch }) {
      let candidates = await dispatch("getDelegates")
      return dispatch("getBondedDelegates", candidates)
    },
    async getMyDelegates({ rootState, commit }) {
      state.loading = true
      try {
        let validators = await node.getDelegatorValidators(
          rootState.user.address
        )
        commit("setDelegatorValidators", validators)
      } catch (err) {
        commit("notifyError", {
          title: "Error fetching all your bonded validators",
          body: err.message
        })
      }
      state.loading = false
    },
    async submitDelegation(
      { rootState, state, dispatch, commit },
      { type, stakeTransactions }
    ) {
      await dispatch("sendTx", {
        type: "updateDelegations",
        to: rootState.wallet.address, // TODO strange syntax
        ...stakeTransactions
      })

      switch (type) {
        case msgDelegation:
          // (optimistic update) we update the atoms of the user before we get the new values from chain
          let atomsDiff = stakeTransactions.delegations
            // compare old and new delegations and diff against old atoms
            .map(delegationObj => {
              // Get the validator to calculate the tokens
              let validator = state.delegates.find(validator => {
                return validator.owner === delegationObj.validator_addr
              })
              return (
                calculateTokens(
                  validator,
                  state.committedDelegates[validator.owner]
                ) - Number(delegationObj.delegation.amount)
              )
            })
            .reduce((sum, diff) => sum + diff, 0)
          commit("setAtoms", rootState.user.atoms + atomsDiff)
          break
      }
      // we optimistically update the committed delegations
      // TODO usually I would just query the new state through the LCD and update the state with the result, but at this point we still get the old shares
      setTimeout(async () => {
        dispatch("updateDelegates") //.then(() =>
        // updateCommittedDelegations(
        //   delegations,
        //   commit
        // )
        // )
      }, 5000)
    },
    async endUnbonding({ rootState, state, dispatch, commit }, validatorAddr) {
      try {
        await dispatch("sendTx", {
          type: "updateDelegations",
          to: rootState.wallet.address, // TODO strange syntax
          complete_unbondings: [
            {
              delegator_addr: rootState.wallet.address,
              validator_addr: validatorAddr
            }
          ]
        })

        let balance = state.unbondingDelegations[validatorAddr].balance
        commit("setUnbondingDelegations", {
          validator_addr: validatorAddr,
          balance: { amount: 0 }
        })
        commit("notify", {
          title: "Ending undelegation successful",
          body: `You successfully undelegated ${balance.amount} ${
            balance.denom
          }s from ${validatorAddr}`
        })
      } catch (err) {
        commit("notifyError", {
          title: "Ending undelegation failed",
          body: err
        })
      }
    }
  }

  return {
    state,
    mutations,
    actions
  }
}
// needed for optimistic updates, uncomment or delete this when that issue is addressed
// function updateCommittedDelegations(delegations, commit) {
//   for (let delegation of delegations) {
//     commit("setCommittedDelegation", {
//       candidateId: delegation.delegate.owner,
//       value: delegation.atoms
//     })
//   }
// }
