// Accord configuration. soma-auth.js is copied verbatim from Legends (2026-09-15).
window.SOMA_AUTH_CONFIG = Object.assign({}, window.PROOF_SOMA_CONFIG, {
  app: 'proof-plus',
  methods: { magicLink: true, emailOtp: false, password: false, phone: false, oauth: ['google'] }
});
