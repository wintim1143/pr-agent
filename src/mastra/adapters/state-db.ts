/**
 * 入口态存储的数据库连接与建表（M5a-1）。
 *
 * ## 为什么复用 `mastra.db` 库文件，而不是新建 `state.db`（M5 卡 §0 拍板项 1 的定案）
 *
 * 去重状态（「这个事件被认领过了吗」）与 workflow 运行态（快照 / suspend / resume）**生命周期不同**，
 * 因此**不复用 Mastra Storage 的表**；但为了让运维只需照看一个文件、备份即完整状态，
 * 二者**共用同一个库文件**。
 *
 * ## 为什么必须是 SQLite 而不是 JSON 文件 / 内存 Map（这一段是本模块存在的唯一理由）
 *
 * 去重需要**原子性**：两个并发 poll 不能都认领同一条消息。
 * SQLite 的 `INSERT OR IGNORE` + 唯一主键提供了**免费且正确**的原子认领原语
 * —— 插入即认领，冲突即「别人已抢先」，由数据库保证二者不会同时发生。
 * JSON 文件与内存 Map 都**没有跨进程原子性**，做同样的事要自己发明锁文件 + 重试，
 * 且在高并发下会出现「双跑」窗口（正是 M5a 要防的那件事）。
 *
 * ## 两条必须遵守的约束
 *
 * 1. ⚠️ **库文件路径与 `src/mastra/index.ts` 同源**：同一个 `MASTRA_DB_PATH`、
 *    同一套 `resolve(process.cwd(), 'mastra.db')` 解析规则。任何一边单独改动都会造成
 *    「Mastra 写 A 库、去重写 B 库」的静默分裂 —— 两边的 run 都对，却互相看不见。
 * 2. ⚠️ **自有表统一加 `pr_agent_` 前缀**，避免与 LibSQLStore 的内部表（`mastra_*`）撞名。
 */
import { resolve } from 'node:path';
import { createClient, type Client } from '@libsql/client';

/** 与 `src/mastra/index.ts` 的 `mastraDbPath` 逐字同源（同一个 env + 同一套解析）。 */
export function stateDbPath(): string {
  return process.env.MASTRA_DB_PATH ?? resolve(process.cwd(), 'mastra.db');
}

/** `file:` URL 形式的库地址（与 LibSQLStore 的写法一致）。 */
export function stateDbUrl(): string {
  return `file:${stateDbPath()}`;
}

let cachedClient: Client | undefined;
let schemaPromise: Promise<void> | undefined;

/** 取（惰性创建的）单例连接。模块加载时**不做任何 IO**，沿用本项目「加载不抛错」的约定。 */
export function getStateDb(): Client {
  if (!cachedClient) {
    cachedClient = createClient({ url: stateDbUrl() });
  }
  return cachedClient;
}

/**
 * 建表（幂等）。所有公开 API 的前置动作。
 *
 * 三张表的职责：
 * - `pr_agent_seen_events`：入口层幂等键账本。**主键即认领原语**。
 * - `pr_agent_cursors`：轮询游标。重启进程后 `sinceTs` 从游标续读，不重放。
 * - `pr_agent_repo_locks`：每仓库互斥锁（M5b-4）。跨进程可见 —— 验证脚本与 HTTP 是不同进程。
 */
export function ensureStateSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getStateDb();
      await db.execute(
        `CREATE TABLE IF NOT EXISTS pr_agent_seen_events (
           key       TEXT PRIMARY KEY,
           source    TEXT NOT NULL,
           seen_at   TEXT NOT NULL,
           run_id    TEXT
         )`
      );
      await db.execute(
        `CREATE TABLE IF NOT EXISTS pr_agent_cursors (
           source     TEXT PRIMARY KEY,
           cursor     INTEGER NOT NULL,
           updated_at TEXT NOT NULL
         )`
      );
      await db.execute(
        `CREATE TABLE IF NOT EXISTS pr_agent_repo_locks (
           repo_key    TEXT PRIMARY KEY,
           holder      TEXT NOT NULL,
           acquired_at INTEGER NOT NULL,
           expires_at  INTEGER NOT NULL
         )`
      );
    })();
  }
  return schemaPromise;
}

/**
 * 丢弃缓存的连接与建表 Promise，使下一次调用按**当前** env 重新解析库路径。
 *
 * 仅供单测 / 验证脚本在进程内切换库文件使用（生产代码不应调用 —— 切换运行中的库
 * 会让已写入的游标与去重记录「消失」）。
 */
export async function resetStateDb(): Promise<void> {
  const c = cachedClient;
  cachedClient = undefined;
  schemaPromise = undefined;
  if (c) {
    try {
      c.close();
    } catch {
      /* 关闭失败不影响后续新建连接；此处不抛，避免清理动作本身变成故障源 */
    }
  }
}
