import { z } from "zod";
import { publicProcedure, router } from "./_core/trpc";
import { randomUUID } from "node:crypto";
import { authorizeWhitelist, getWhitelistPlatform } from "./whitelist";
import {
  deleteTrackerSession,
  findTrackerSessionByUser,
  hasActiveTrackerSession,
  loadTrackerSession,
  saveTrackerSession,
} from "./sessions";

export { hasActiveTrackerSession } from "./sessions";
export { requireTrackerSession } from "./sessions";

export const appRouter = router({
  trackerAccess: router({
    resolvePlatform: publicProcedure
      .input(z.object({ username:z.string().min(1).max(128) }))
      .mutation(async ({input}) => getWhitelistPlatform(input.username)),
    login: publicProcedure
      .input(z.object({
        username: z.string().min(1).max(128),
        tzToken: z.string().min(16).max(8192),
        deviceId: z.string().min(1).max(128).optional(),
        platform: z.enum(["TZ","OFA"]).default("TZ"),
      }))
      .mutation(async ({ input }) => {
        const username = input.username.trim().toLowerCase();
        if (!username || !input.tzToken.trim()) return { success: false, sessionId: "", reason: "invalid_login" } as const;

        const platform=input.platform;
        const access = await authorizeWhitelist(username, platform);
        if (!access.allowed) return { success: false, sessionId: "", reason: access.reason } as const;

        const existing = await findTrackerSessionByUser(platform, username);
        const sessionId = existing?.sessionId || randomUUID();
        await saveTrackerSession({ sessionId, platform, username });
        return { success: true, sessionId } as const;
      }),
    checkSession: publicProcedure
      .input(z.object({ sessionId: z.string().min(1).max(128) }))
      .query(async ({ input }) => {
        const current = await loadTrackerSession(input.sessionId);
        if (!current) return { valid: false, reason: "session_expired" } as const;

        const access = await authorizeWhitelist(current.username, current.platform);
        if (!access.allowed) {
          await deleteTrackerSession(input.sessionId);
          return { valid: false, reason: access.reason } as const;
        }
        return { valid: true, reason: "ok" } as const;
      }),
    logout: publicProcedure
      .input(z.object({ sessionId: z.string().min(1).max(128) }))
      .mutation(async ({ input }) => {
        await deleteTrackerSession(input.sessionId);
        return { success: true } as const;
      }),
  }),
});

export type AppRouter = typeof appRouter;
