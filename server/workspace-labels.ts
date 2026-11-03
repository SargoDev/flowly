import { openLocalDaemon, LocalDaemonUnavailable } from "./local-daemon";
import { paseoHome } from "./service";
import { logFailure } from "./error-report";
import type { Board, BoardEvent, Status } from "../shared/model";
import type { WorkspaceLabelColor } from "@getpaseo/protocol/dist/workspace-labels";

export const FLOWLY_STATUS_LABELS: Record<string, { name: string; color: WorkspaceLabelColor } | null> = {
  design: { name: "design", color: "sky" },
  development: { name: "development", color: "amber" },
  test: { name: "test", color: "emerald" },
  in_review: { name: "in_review", color: "violet" },
  blocked: { name: "blocked", color: "red" },
  done: null,
  cancelled: null,
  backlog: null,
  todo: null,
};

export const MANAGED_LABELS: readonly { name: string; color: WorkspaceLabelColor }[] = [
  { name: "design", color: "sky" },
  { name: "development", color: "amber" },
  { name: "test", color: "emerald" },
  { name: "in_review", color: "violet" },
  { name: "blocked", color: "red" },
];

export class WorkspaceLabelSync {
  private tail: Promise<void> = Promise.resolve();
  private readonly home: string;

  constructor(home = paseoHome()) {
    this.home = home;
  }

  syncTask(workspaceId: string, newStatus: string, previousStatus?: string) {
    if (!workspaceId) return;
    this.tail = this.tail
      .then(() => this.doSync(workspaceId, newStatus, previousStatus))
      .catch((e) => {
        if (!(e instanceof LocalDaemonUnavailable)) {
          logFailure("Workspace label sync failed:", e);
        }
      });
  }

  private async doSync(workspaceId: string, newStatus: string, previousStatus?: string) {
    const target = FLOWLY_STATUS_LABELS[newStatus] ?? null;
    const prev = previousStatus ? FLOWLY_STATUS_LABELS[previousStatus] : undefined;

    let client;
    try {
      client = await openLocalDaemon(
        this.home,
        "flowly-workspace-labels",
        ["setWorkspaceLabel"],
        "This Paseo version does not support workspace labels.",
      );
    } catch (e) {
      if (e instanceof LocalDaemonUnavailable) return;
      throw e;
    }

    try {
      if (prev && (!target || prev.name !== target.name)) {
        await client.setWorkspaceLabel({
          workspaceId,
          label: prev,
          assigned: false,
        }).catch(() => undefined);
      } else if (!previousStatus) {
        for (const label of MANAGED_LABELS) {
          if (!target || label.name !== target.name) {
            await client.setWorkspaceLabel({
              workspaceId,
              label,
              assigned: false,
            }).catch(() => undefined);
          }
        }
      }

      if (target) {
        await client.setWorkspaceLabel({
          workspaceId,
          label: target,
          assigned: true,
        }).catch(() => undefined);
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  handleEvents(events: readonly BoardEvent[], board: Board) {
    for (const e of events) {
      if (e.action === "status_changed" && e.to) {
        const task = board.tasks.find((t) => t.id === e.taskId);
        if (task?.workspaceId) {
          this.syncTask(task.workspaceId, e.to, e.from);
        }
      }
    }
  }

  async reconcile(tasks: readonly { workspaceId: string; status: string; archivedAt?: string | null }[]) {
    for (const t of tasks) {
      if (t.workspaceId && !t.archivedAt) {
        this.syncTask(t.workspaceId, t.status);
      }
    }
    await this.tail.catch(() => undefined);
  }
}
