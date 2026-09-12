import { registerProvider } from "../registry";
import { simulatorHandler, simulatorProvider } from "./simulator";

/**
 * Import this module once (the webhook route does) to register every
 * provider. WhatsApp (phase 4), Stripe (phase 6) and Google (phase 7) will
 * be added here.
 */
registerProvider(simulatorProvider, simulatorHandler);
