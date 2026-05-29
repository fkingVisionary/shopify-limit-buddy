// Server-fn middleware: validates the x-workspace-device-token header,
// puts `{ workspaceId, deviceId, deviceName }` into context.
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { authDeviceByToken } from "@/lib/workspace-store";

export const HEADER = "x-workspace-device-token";

export const requireWorkspaceDevice = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const req = getRequest();
    const token = req?.headers.get(HEADER) ?? null;
    const device = await authDeviceByToken(token);
    if (!device) {
      throw new Error("WorkspaceUnauthorized: invalid or missing device token");
    }
    return next({
      context: {
        workspaceId: device.workspaceId,
        deviceId: device.id,
        deviceName: device.name,
      },
    });
  },
);
