import { initializeWebsite } from "./app.js";

// Publicly served/default entry remains browser-local. The private account
// candidate uses a separately selected entry, never a query-string toggle.
await initializeWebsite();
