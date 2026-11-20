export default {
  appId: "demo-app",
  api: {
    baseUrl: process.env.I18N_DEMO_API_URL ?? "http://127.0.0.1:4179",
    getUrl: (appId) => `/generics/translations/${encodeURIComponent(appId)}`,
    postUrl: "/generics/translations",
    batchSize: 1,
    parseExisting: (body) => {
      const english = body?.en;
      if (!english || typeof english !== "object" || Array.isArray(english) ||
          Object.values(english).some((value) => typeof value !== "string")) {
        throw new Error("Expected an English translation map in the GET response");
      }
      return Object.keys(english);
    },
    buildPayload: ([key]) => ({ key, value: key }),
  },
};
