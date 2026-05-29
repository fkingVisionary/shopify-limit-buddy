// Client-side function middleware: attaches the workspace device token
// (from localStorage) to every server-fn RPC.
import { createMiddleware } from "@tanstack/react-start";
import { HEADER } from "./middleware";
import { readDeviceToken } from "./client";

export const attachWorkspaceToken = createMiddleware({ type: "function" }).client(
  async ({ next }) => {
    const token = readDeviceToken();
    return next({ headers: token ? { [HEADER]: token } : {} });
  },
);
