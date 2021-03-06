import * as Sentry from "@sentry/browser"
import { track } from "scripts/google-analytics.js"
import config from "src/config"
import { loadKeys, importKey, testPassword } from "../../scripts/keystore.js"
import { generateSeed } from "../../scripts/wallet.js"

export default () => {
  const ERROR_COLLECTION_KEY = `voyager_error_collection`

  const state = {
    developmentMode: config.development, // can't be set in browser
    experimentalMode: config.development, // development mode, can be set from browser
    insecureMode: false, // show the local signer
    gasPrice: config.default_gas_price, // price per unit of gas
    gasAdjustment: config.default_gas_adjustment, // default adjustment multiplier
    signedIn: false,
    sessionType: null, // local, ledger
    accounts: [],
    localKeyPairName: null, // used for signing with a locally stored key; TODO: move into own module
    pauseHistory: false,
    history: [],
    address: null,
    errorCollection: false,
    stateLoaded: false, // shows if the persisted state is already loaded. used to prevent overwriting the persisted state before it is loaded
    error: null,
    modals: {
      error: { active: false },
      help: { active: false },
      session: {
        active: false,
        state: `welcome`
      }
    },

    // import into state to be able to test easier
    externals: {
      config,
      loadKeys,
      importKey,
      testPassword,
      generateSeed,
      track,
      Sentry
    }
  }

  const mutations = {
    setSignIn(state, hasSignedIn) {
      state.signedIn = hasSignedIn
    },
    setSessionType(state, sessionType) {
      state.sessionType = sessionType
    },
    setAccounts(state, accounts) {
      state.accounts = accounts
    },
    setUserAddress(state, address) {
      state.address = address
    },
    setExperimentalMode(state) {
      state.experimentalMode = true
    },
    setInsecureMode(state) {
      state.insecureMode = true
    },
    addHistory(state, path) {
      state.history.push(path)
      state.externals.track(`pageview`, {
        dl: path
      })
    },
    popHistory(state) {
      state.history.pop()
    },
    pauseHistory(state, paused) {
      state.pauseHistory = paused
    },
    toggleSessionModal(state, value) {
      state.modals.session.active = value
    },
    setSessionModalView(state, value) {
      state.modals.session.state = value
    }
  }

  const actions = {
    async reconnected({ dispatch }) {
      // reload available accounts as the reconnect could be a result of a switch from a mocked connection with mocked accounts
      await dispatch(`loadAccounts`)
    },
    async showInitialScreen({ state, dispatch }) {
      dispatch(`resetSessionData`)
      await dispatch(`loadAccounts`)
      state.externals.track(`pageview`, { dl: `/` })
    },
    async checkForPersistedSession({ dispatch }) {
      const session = localStorage.getItem(`session`)
      if (session) {
        const { localKeyPairName, address, sessionType } = JSON.parse(session)
        dispatch(`signIn`, { localKeyPairName, address, sessionType })
      }
    },
    async persistSession(store, { localKeyPairName, address, sessionType }) {
      localStorage.setItem(
        `session`,
        JSON.stringify({ localKeyPairName, address, sessionType })
      )
    },
    async loadAccounts({ commit, state }) {
      state.loading = true
      try {
        const keys = await state.externals.loadKeys()
        commit(`setAccounts`, keys)
      } catch (error) {
        state.externals.Sentry.captureException(error)
        commit(`notifyError`, {
          title: `Couldn't read keys`,
          body: error.message
        })
        state.error = error
      } finally {
        state.loading = false
      }
    },
    async testLogin(store, { password, localKeyPairName }) {
      return await testPassword(localKeyPairName, password)
    },
    createSeed() {
      return state.externals.generateSeed()
    },
    async createKey({ dispatch, state }, { seedPhrase, password, name }) {
      state.externals.track(`event`, `session`, `create-keypair`)

      const { cosmosAddress } = await state.externals.importKey(
        name,
        password,
        seedPhrase
      )
      await dispatch(`initializeWallet`, { address: cosmosAddress })
      return cosmosAddress
    },
    // TODO split into sign in with ledger and signin with local key
    async signIn(
      { state, commit, dispatch },
      {
        localKeyPairName,
        address,
        sessionType = `local`,
        errorCollection = false
      }
    ) {
      let accountAddress
      switch (sessionType) {
        case `ledger`:
        case `explore`:
          accountAddress = address
          break
        default:
          // local keyStore
          state.localKeyPairName = localKeyPairName
          accountAddress = await getLocalAddress(state, localKeyPairName)
      }
      commit(`setSignIn`, true)
      commit(`setSessionType`, sessionType)
      commit(`setUserAddress`, accountAddress)
      dispatch(`setErrorCollection`, {
        account: accountAddress,
        optin: errorCollection
      })
      await dispatch(`loadPersistedState`)
      commit(`toggleSessionModal`, false)
      dispatch(`loadErrorCollection`, accountAddress)
      await dispatch(`initializeWallet`, { address: accountAddress })
      dispatch(`persistSession`, {
        localKeyPairName,
        address: accountAddress,
        sessionType
      })

      state.externals.track(`event`, `session`, `sign-in`, sessionType)
    },
    signOut({ state, commit, dispatch }) {
      state.externals.track(`event`, `session`, `sign-out`)

      state.localKeyPairName = null
      commit(`setLedgerConnection`, false)
      commit(`setCosmosAppVersion`, {})
      dispatch(`resetSessionData`)
      commit(`addHistory`, `/`)
      commit(`setSignIn`, false)
      localStorage.removeItem(`session`)
    },
    resetSessionData({ commit, state }) {
      state.history = []
      state.localKeyPairName = null
      commit(`setUserAddress`, null)
    },
    loadErrorCollection({ state, dispatch }, address) {
      const errorCollection =
        localStorage.getItem(`${ERROR_COLLECTION_KEY}_${address}`) === `true`
      if (state.errorCollection !== errorCollection)
        dispatch(`setErrorCollection`, { address, optin: errorCollection })
    },
    setErrorCollection({ state, commit }, { address, optin }) {
      if (optin && state.externals.config.development) {
        commit(`notifyError`, {
          title: `Couldn't switch on error collection.`,
          body: `Error collection is disabled during development.`
        })
      }
      state.errorCollection = state.externals.config.development ? false : optin
      localStorage.setItem(
        `${ERROR_COLLECTION_KEY}_${address}`,
        state.errorCollection
      )

      if (state.errorCollection) {
        state.externals.Sentry.init({
          dsn: state.externals.config.sentry_dsn,
          release: state.externals.config.version
        })
        console.log(`Error collection has been enabled`)
        state.externals.track(`pageview`, {
          dl: window.location.pathname
        })
      } else {
        console.log(`Error collection has been disabled`)
        state.externals.Sentry.init({})
      }
    }
  }

  return {
    state,
    mutations,
    actions
  }
}

async function getLocalAddress(state, localKeyPairName) {
  return (await state.externals.loadKeys()).find(
    ({ name }) => name === localKeyPairName
  ).address
}
