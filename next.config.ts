import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

// The Sentry build plugin (source maps, release tagging) only when reporting is on.
export default process.env.SENTRY_DSN
  ? withSentryConfig(nextConfig, {
      silent: true,
      // Source-map upload needs SENTRY_AUTH_TOKEN, SENTRY_ORG and SENTRY_PROJECT;
      // without them the build still succeeds, just without readable stacks.
      sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
    })
  : nextConfig;
