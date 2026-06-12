module.exports = {
  dependencies: {
    // This completely prevents the native build from looking into the expo folder
    'expo': {
      platforms: {
        android: null,
        ios: null,
      },
    },
  },
};