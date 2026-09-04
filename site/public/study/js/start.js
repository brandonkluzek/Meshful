import { initializeWebsite } from "./app.js?release=v72-guest-study-reset";

// Publicly served/default entry remains browser-local. The private account
// candidate uses a separately selected entry, never a query-string toggle.
await initializeWebsite();
