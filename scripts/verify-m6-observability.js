/**
 * M6 验收脚本：可观测与成本。
 *
 * ## 为什么是**独立脚本**
 *
 * `verify-pr-loop.js` / `verify-m4-gate.js` / `verify-m5-multirepo.js` 是**已归档的证据产出器**
 * —— 改动它们会让当时那份证据失去可重现性。M6 自己一份（与 M5 同一条方法学）。
 *
 * ## 模式
 *
 * | 模式 | 耗时 | 覆盖 | 碰远端 / LLM |
 * |---|---|---|---|
 * | `--contract` | 秒级 | AC-1 规范成文 / AC-2 裸 console 白名单 | 否 |
 * | `--pairing` | 秒级 | AC-4 配对（**并报告历史偏差**）/ AC-8 终态唯一 | 否 |
 * | `--interleave` | 秒级 | AC-6 双 run 交错互不串入（**跨进程**） | 否 |
 * | `--rotate` | 秒级 | AC-10 轮转 + 轮转后当前 run 不残缺（**跨进程**） | 否 |
 * | `--failopen` | 秒级 | AC-9 日志不可写时**不阻断**（真实 fs 错误） | 否 |
 * | `--cost` | 秒级 | AC-7 `usage` 归一 + 按仓库聚合 + `null ≠ 0` | 否 |
 * | `--report <runId>` | 秒级 | AC-5 按 runId 重建八步时间线（**且不读 mastra.db**） | 否 |
 * | `--attribution` | 秒级 | AC-3 新格式记录**必须**带 runId（需先有真实 run） | 否 |
 * | `--live` | **分钟级** | 端到端真实 run（真 LLM + 真闸门），产出 AC-3/AC-5/AC-7 的一手证据 | 是（LLM） |
 * | `--all` | — | 先跑上面全部"秒级"模式，再跑单测与 M5 回归（AC-11） | 部分 |
 *
 * ## 三个刻意的设计选择
 *
 * 1. **AC-6 / AC-9 / AC-10 一律跨进程**：进程内的 `Promise.all` 只能证明「同一个
 *    require 缓存里的两次调用」，证明不了「两个独立进程不会互相干扰」。
 *    与 M3-5「同进程验 resume 等于没验持久化」、M5a「跨进程验认领」同一条方法学。
 * 2. **历史偏差只报告、不断言**：M6 之前的 701 条事件**没有 runId**，任何「按 run 归因」
 *    都是编造。`--pairing` 把它们单列一桶打出来（`step:start` 141 vs `done+fail` 146 是
 *    真实存在的不对称），但**通过与否只看新格式数据**。抹平历史＝伪造历史。
 * 3. **`--report` 断言「没碰 mastra.db」**：通过检查 `require.cache` 里没有
 *    `better-sqlite3` / `@libsql` / `mastra/index.js` 来证明，而不是靠注释声称。
 *    这正是 M6 要消掉的那条手工手法（反查 snapshot 表 → 手工切分日志）。
 *
 * ## 环境变量（都有缺省）
 *
 *   M6_LIVE_TARGET   缺省 `local/pr-agent-e2e-b`（本地仓库，stopAfterCommit，**不碰远端**）
 *   M6_LIVE_ISSUE    缺省 902
 *   M6_TOTAL_TIMEOUT_MS  单次 run 兜底超时，缺省 1200000
 *   M6_FAST_PAIRING  设 0 时 `--all` 不跑 `--pairing`（历史偏差较多时用）
 *
 * 证据追加写 `logs/m6-verify.log`（覆写丢过证据，本项目已踩）。
 */
'use strict';
require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');

const PR_AGENT = path.resolve(__dirname, '..');
const LOG = path.resolve(PR_AGENT, 'logs/m6-verify.log');
const PROGRESS_LOG = path.resolve(PR_AGENT, 'logs/dev-workflow.log');
const SPEC_DOC = path.resolve(PR_AGENT, 'docs/日志规范.md');

/**
 * M6 开工前的单测基线（M5 收口时的数字，见 `M5-多仓库与幂等.md`）。
 * 只用于**展示**「本里程碑新增了多少条」，不参与判负 —— 判负看的是
 * 「通过数 === 总数」且「总数 ≥ 基线」（`AC-11a`）。
 */
const BASELINE_TESTS = 243;

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const argOf = f => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const results = [];
/** 子进程模式标记 —— 见文件末尾 `if (!CHILD_MODE)` 的说明。 */
const CHILD_MODE = has('--child-interleave') || has('--child-rotate') || has('--child-failopen');
function log(line = '') {
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line + '\n');
  } catch {
    /* 证据写不进去不该让验收脚本崩掉 */
  }
}
function judge(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail });
  log(`  ${ok ? '✅' : '❌'} ${id}  ${detail}`);
  return Boolean(ok);
}

/** 取 dist 里的模块（脚本一律跑编译产物，与 workflow 运行时同一份代码）。 */
function dist(rel) {
  return require(path.resolve(PR_AGENT, 'dist', rel));
}

/** 读取日志（可用 env 覆盖路径 —— 供隔离场景使用）。 */
function readEnv(file) {
  return { ...process.env, PR_AGENT_PROGRESS_FILE: file };
}
function readAll(file = PROGRESS_LOG) {
  return dist('mastra/log-store.js').readAllRecords(readEnv(file));
}
function readRun(runId, file = PROGRESS_LOG) {
  return dist('mastra/log-store.js').readRun(runId, readEnv(file));
}

/** 新格式记录（带 `traceId` 字段 = M6 之后写出）—— AC-3 的适用范围就是这个集合。 */
function modernRecords(records) {
  return records.filter(r => 'traceId' in r);
}
/** 规范允许 `runId: null` 的阶段。 */
const RUNLESS = new Set(['startup', 'logger', 'inbound']);
const STEPS = ['checkout', 'coding', 'test', 'review', 'commit', 'push-open-pr', 'notify', 'merge'];

function banner(title) {
  log('');
  log('─'.repeat(78));
  log(`▶ ${title}`);
}

// ============================================================================
// 子进程入口（跨进程场景专用）
// ============================================================================
if (has('--child-interleave')) {
  const file = argOf('--child-interleave');
  const runId = argOf('--child-run');
  const gate = argOf('--gate');
  const { stage } = dist('mastra/progress.js');
  process.env.PR_AGENT_PROGRESS_FILE = file;
  /**
   * 起跑闸（barrier）：两个子进程都**先等同一个文件出现**，再同时开始写。
   *
   * 为什么需要：只靠「同时 spawn」并不保证真的交错 —— 进程启动有先后，
   * 后起的那一个往往在前一个已经写完 4 条之后才开始写，于是顺序变成 AAAA BBBB，
   * 用例就退化成「顺序写两次」，**证明不了并发下的隔离**（实测就是这样）。
   * 有了闸，再配合每条之间 25ms 的间隔，写窗口必然重叠。
   */
  const waitGate = async () => {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(gate)) {
      if (Date.now() > deadline) throw new Error(`起跑闸超时：${gate}`);
      await new Promise(r => setTimeout(r, 5));
    }
  };
  const main = async () => {
    await waitGate();
    for (const event of ['step:start', 'llm:start', 'llm:done', 'step:done']) {
      stage(event, { stage: 'coding', runId, note: `${runId}-${event}` });
      await new Promise(r => setTimeout(r, 25));
    }
  };
  main().then(
    () => process.exit(0),
    e => {
      console.error(e);
      process.exit(1);
    }
  );
}

if (has('--child-rotate')) {
  const file = argOf('--child-rotate');
  const runId = argOf('--child-run');
  const count = Number(argOf('--count') || 12);
  process.env.PR_AGENT_PROGRESS_FILE = file;
  process.env.PR_AGENT_LOG_MAX_BYTES = '300';
  process.env.PR_AGENT_LOG_KEEP = '5';
  const { stage } = dist('mastra/progress.js');
  for (let i = 0; i < count; i++) {
    stage('step:done', { stage: 'coding', runId, seq: String(i).padStart(2, '0') });
  }
  process.exit(0);
}

if (has('--child-failopen')) {
  // 把落盘路径指向一个**目录** —— append 必然 EISDIR，这是真实的 fs 错误，不是 mock
  const badPath = argOf('--child-failopen');
  process.env.PR_AGENT_PROGRESS_FILE = badPath;
  const { stage, stageStart, runStart, runEnd } = dist('mastra/progress.js');
  const r = { threw: null };
  try {
    runStart({ stage: 'checkout', runId: 'FAILOPEN-RUN' });
    stageStart({ stage: 'coding', runId: 'FAILOPEN-RUN' }).done({ ok: true });
    stageStart({ stage: 'test', runId: 'FAILOPEN-RUN' }).fail(new Error('闸门判负'));
    stage('guard:deny', { stage: 'coding', runId: 'FAILOPEN-RUN', tool: 'Bash', reason: 'x' });
    runEnd({ stage: 'test', runId: 'FAILOPEN-RUN', status: 'failed', failedStage: 'test', reason: 'x' });
  } catch (e) {
    r.threw = e instanceof Error ? e.message : String(e);
  }
  console.log(JSON.stringify(r));
  process.exit(r.threw ? 1 : 0);
}

// ============================================================================
// AC-1 / AC-2 · --contract
// ============================================================================
function modeContract() {
  banner('AC-1 日志规范成文 / AC-2 裸 console 白名单');

  // ---- AC-1 ----
  const exists = fs.existsSync(SPEC_DOC);
  if (!judge('AC-1a', exists, `docs/日志规范.md 存在（${exists ? 'ok' : '缺失'}）`)) return;
  const doc = fs.readFileSync(SPEC_DOC, 'utf8');
  // 五要件逐条对照（规范 §0.1 是这张对照表本身）
  const required = [
    ['必落文件', '哪些输出必须落文件'],
    ['级别', '级别（何时走 stderr）'],
    ['字段必填', '字段必填与命名'],
    ['禁止裸', '禁止裸 console'],
    ['阶段名闭集', '阶段名闭集'],
  ];
  const missing = required.filter(([tok]) => !doc.includes(tok)).map(([, label]) => label);
  judge('AC-1b', missing.length === 0, missing.length ? `规范缺要件：${missing.join(' / ')}` : `五要件齐备（${required.length}/${required.length}）`);
  judge('AC-1c', doc.includes('console'), '规范里给出了裸 console 的判定命令与白名单');

  // ---- AC-2 ----
  const srcDir = path.resolve(PR_AGENT, 'src');
  const RE = /console\.(log|warn|error|info|debug)\s*\(/;
  const hits = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) {
        fs.readFileSync(p, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            // 只算真正的调用：行首是注释的不算（规范里的说明文字会引用 console.*）
            const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
            if (RE.test(code)) hits.push({ file: path.relative(PR_AGENT, p).replace(/\\/g, '/'), line: i + 1, code: code.trim() });
          });
      }
    }
  })(srcDir);

  const WHITELIST_FILE = 'src/mastra/progress.ts';
  const stray = hits.filter(h => h.file !== WHITELIST_FILE);
  judge(
    'AC-2a',
    stray.length === 0,
    stray.length === 0
      ? `src/ 下除 ${WHITELIST_FILE} 外零裸 console`
      : `发现 ${stray.length} 处越界裸 console：\n${stray.map(s => `      ${s.file}:${s.line}  ${s.code.slice(0, 90)}`).join('\n')}`
  );
  judge(
    'AC-2b',
    hits.length === 4 && hits.every(h => h.file === WHITELIST_FILE),
    `白名单命中 ${hits.length} 处（期望 4，全部在 ${WHITELIST_FILE}）：${hits.map(h => `${h.file}:${h.line}`).join(', ')}`
  );
}

// ============================================================================
// AC-4 / AC-8 · --pairing
// ============================================================================
function modePairing() {
  banner('AC-4 start↔end 配对 / AC-8 run 终态唯一（真实日志）');
  const { pairingReport, llmSummary } = dist('mastra/log-store.js');
  const all = readAll();
  const rep = pairingReport(all.records);

  log(`  日志：${all.files.map(f => path.basename(f)).join(', ') || '(无)'}`);
  log(`  记录 ${rep.totals.events} 条 · 有 runId ${rep.totals.attributed} · 归不到 run ${rep.totals.unattributed} · 不同 run ${rep.totals.runs} 个 · 非 JSON 行 ${all.badLines}`);
  log(`  事件分布：${Object.entries(rep.totals.byEvent).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  // ---- 历史偏差：只报告（M6 之前没有 runId，任何归因都是编造）----
  if (rep.legacyUnbalanced.length) {
    log('');
    log('  ℹ️  历史遗留（无 runId）不平衡 —— **只报告，不作为判据**：');
    for (const r of rep.legacyUnbalanced) {
      log(`      stage=${r.stage}  start=${r.starts}  done=${r.done}  fail=${r.fail}  Δ=${r.delta}`);
    }
    const t = rep.legacyUnbalanced.reduce((a, r) => a + r.delta, 0);
    log(`      合计 Δ=${t}（>0 表示有 start 无 end；<0 表示有 end 无 start —— 后者正是「判负处先 p.fail 再 throw 导致一个 step 两条 step:fail」的签名）`);
  } else {
    log('  ℹ️  历史遗留无不平衡项。');
  }

  // ---- 新格式：这才是判据 ----
  judge('AC-4a', rep.unbalanced.length === 0, rep.unbalanced.length === 0 ? '新格式（带 runId）按 (runId, stage) 全部配对' : `新格式仍有 ${rep.unbalanced.length} 处不平衡：${JSON.stringify(rep.unbalanced)}`);

  const records = all.records;
  const started = new Set(records.filter(r => r.event === 'run:start' && r.runId).map(r => r.runId));
  const ended = new Map();
  for (const r of records) if (r.event === 'run:end' && r.runId) ended.set(r.runId, (ended.get(r.runId) || 0) + 1);
  const multi = [...ended.entries()].filter(([, n]) => n !== 1);
  judge('AC-8a', multi.length === 0, multi.length === 0 ? `每个 run 有且仅有 1 条 run:end（共 ${started.size} 个 run）` : `有 ${multi.length} 个 run 的 run:end 数 ≠ 1：${JSON.stringify(multi)}`);
  const noEnd = [...started].filter(id => !ended.has(id));
  log(`  ℹ️  有 run:start 但尚无 run:end 的 run：${noEnd.length ? noEnd.map(id => id.slice(0, 8)).join(', ') : '无'}（挂起中的人等关卡属正常）`);

  // ---- LLM 参考项（不是判据：重试耗尽时最后一次失败没有终态事件）----
  const llm = llmSummary(records);
  if (Object.keys(llm).length) {
    log('');
    log('  ℹ️  LLM 调用统计（参考项，非判据）：');
    for (const [stage, s] of Object.entries(llm)) {
      log(`      ${stage.padEnd(10)} start=${s.starts} done=${s.done} retry=${s.retry} heartbeat=${s.heartbeats}  Δ=${s.starts - s.done - s.retry}`);
    }
  }
}

// ============================================================================
// AC-6 · --interleave（跨进程）
// ============================================================================
async function modeInterleave() {
  banner('AC-6 双 run 交错互不串入（跨进程**并发**，确定性）');
  const { spawn } = require('node:child_process');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-interleave-'));
  const file = path.join(dir, 'dev-workflow.log');
  const runA = 'interleave-AAAA-1111';
  const runB = 'interleave-BBBB-2222';

  /**
   * ⚠️ 必须用 `spawn`（异步并发）而不是 `spawnSync`：
   * 后者是**串行**的 —— 第二个进程要等第一个退出才启动，
   * 于是「两个 run 同时往一个文件写」这个被测场景根本没发生，
   * 测试会因为「压根没并发」而通过（M5a 的 AC-2 踩过同一个坑）。
   */
  const gate = path.join(dir, 'GO');
  const runChild = runId =>
    new Promise(resolve => {
      const cp = spawn(process.execPath, [__filename, '--child-interleave', file, '--child-run', runId, '--gate', gate], {
        cwd: PR_AGENT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      cp.stderr.on('data', d => (err += d));
      cp.on('close', code => resolve({ code, err }));
    });
  // 先让两个进程都起来（各自阻塞在起跑闸上），再放行 —— 这样写窗口才真的重叠
  const kids = Promise.all([runChild(runA), runChild(runB)]);
  await new Promise(r => setTimeout(r, 400));
  fs.writeFileSync(gate, 'go');
  const done = await kids;
  const bad = done.filter(k => k.code !== 0);
  judge('AC-6a', bad.length === 0, bad.length === 0 ? '两个子进程**并发**正常退出（无撕裂写入导致的异常）' : `子进程失败：${bad.map(b => b.err).join(' | ')}`);

  const store = dist('mastra/log-store.js');
  const env = readEnv(file);
  const a = store.readRun(runA, env);
  const b = store.readRun(runB, env);
  const okA = a.length === 4 && a.every(r => r.runId === runA);
  const okB = b.length === 4 && b.every(r => r.runId === runB);
  judge('AC-6b', okA && okB, `runA 取回 ${a.length}/4 条且全部属于 A；runB 取回 ${b.length}/4 条且全部属于 B`);
  judge(
    'AC-6c',
    !a.some(r => String(r.note || '').includes(runB)) && !b.some(r => String(r.note || '').includes(runA)),
    '两 run 的事件零串入（严格 runId 相等比较，非前缀匹配）'
  );

  // 交错确实发生了：整个文件的 ts 顺序里 A、B 是交替出现的
  const allTs = store.readAllRecords(env).records;
  const order = allTs.map(r => (r.runId === runA ? 'A' : 'B')).join('');
  const interleaved = order.length === 8 && order !== 'AAAABBBB' && order !== 'BBBBAAAA';
  judge('AC-6d', allTs.length === 8, `文件里总共 8 条（4+4，无丢失、无撕裂）：实测 ${allTs.length} 条`);
  judge('AC-6e', interleaved, `写入确实交错（顺序 ${order}）—— 否则本用例只是「顺序写两次」，证明不了并发下的隔离`);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ============================================================================
// AC-10 · --rotate（跨进程）
// ============================================================================
function modeRotate() {
  banner('AC-10 轮转生效且当前 run 事件无缺（跨进程，确定性）');
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-rotate-'));
  const file = path.join(dir, 'dev-workflow.log');
  const runId = 'rotate-run-7777';
  const count = 12;

  const k = spawnSync(
    process.execPath,
    [__filename, '--child-rotate', file, '--child-run', runId, '--count', String(count)],
    { cwd: PR_AGENT, encoding: 'utf8' }
  );
  judge('AC-10a', k.status === 0, k.status === 0 ? '子进程正常退出' : `子进程失败：${k.stderr}`);

  const env = { ...readEnv(file), PR_AGENT_LOG_MAX_BYTES: '300', PR_AGENT_LOG_KEEP: '5' };
  const store = dist('mastra/log-store.js');
  const all = store.readAllRecords(env);
  const files = fs.readdirSync(dir).filter(f => f.startsWith('dev-workflow.log'));
  judge('AC-10b', files.length > 1, `实际产生了 ${files.length} 个文件（含轮转）：${files.sort().join(', ')}`);

  const mine = store.readRun(runId, env);
  const seqOk =
    mine.length === count &&
    mine.map(r => r.seq).join(',') === Array.from({ length: count }, (_, i) => String(i).padStart(2, '0')).join(',');
  judge(
    'AC-10c',
    seqOk,
    seqOk
      ? `轮转把同一个 run 切成了多份，读取器仍取回全部 ${count} 条且顺序正确（无缺、无乱序）`
      : `当前 run 事件残缺或乱序：取回 ${mine.length}/${count} 条`
  );

  // 契约：读取顺序是最旧 → 最新（不按 ts 排序）
  const order = store.readOrder(file, 5);
  judge('AC-10d', order[order.length - 1] === file, `读取顺序契约：最后读当前文件（${order.map(p => path.basename(p)).join(' → ')}）`);

  fs.rmSync(dir, { recursive: true, force: true });
}

// ============================================================================
// AC-9 · --failopen（跨进程，真实 fs 错误）
// ============================================================================
function modeFailopen() {
  banner('AC-9 日志不可写时不得阻断业务（真实 fs 错误，非 mock）');
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm6-failopen-'));

  // 路径指向**目录本身** → appendFileSync 必然 EISDIR
  const k = spawnSync(process.execPath, [__filename, '--child-failopen', dir], { cwd: PR_AGENT, encoding: 'utf8' });
  let parsed = null;
  try {
    parsed = JSON.parse((k.stdout || '').trim().split('\n').pop());
  } catch {
    /* 解析失败下面会判定 */
  }
  judge(
    'AC-9a',
    k.status === 0 && parsed && parsed.threw === null,
    `落盘路径不可写时 5 类写入（run:start / step:done / step:fail / guard:deny / run:end）全部不抛错，进程退出码 ${k.status}`
  );
  const warned = /写日志失败/.test(k.stderr || '');
  judge('AC-9b', warned, warned ? 'stderr 上留下了一条可检索的告警（吞掉但不静默）' : '⚠️ 未在 stderr 看到「写日志失败」告警 —— 失败被静默吞掉了');
  judge('AC-9c', !fs.readdirSync(dir).some(f => f === 'dev-workflow.log'), '确认真的没写成功（排除「其实写进去了所以没报错」的假阳性）');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ============================================================================
// AC-7 · --cost
// ============================================================================
function modeCost() {
  banner('AC-7 成本可归口 + null ≠ 0');
  const { normalizeUsage, costByRepo } = dist('mastra/log-store.js');

  judge('AC-7a', normalizeUsage(undefined) === null, '拿不到 usage → null');
  judge('AC-7b', normalizeUsage({}) === null, '空对象 → null（不是 {0,0,0}）');
  const zero = normalizeUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  judge('AC-7c', zero !== null && zero.totalTokens === 0, '真实的 0 保留为 0 —— 与 null **严格不等价**（与 M4 的 testsPassed=null≠true 同构）');
  judge('AC-7d', normalizeUsage({ inputTokens: 10, outputTokens: 5 }).totalTokens === 15, 'AI SDK v5（input/outputTokens）可算 total');
  judge('AC-7e', normalizeUsage({ promptTokens: 7, completionTokens: 3, totalTokens: 10 }).totalTokens === 10, '兼容 v4（prompt/completionTokens）命名');

  const all = readAll();
  const rows = costByRepo(all.records);
  log('');
  log('  按仓库聚合（真实日志）：');
  if (!rows.length) {
    log('      （无 llm:done 记录 —— 先跑 --live 产生真实数据）');
  } else {
    log(`      ${'repoKey'.padEnd(34)} llmCalls  totalTokens  unknownUsage`);
    for (const r of rows) {
      log(`      ${r.repoKey.padEnd(34)} ${String(r.llmCalls).padStart(8)} ${String(r.totalTokens).padStart(12)} ${String(r.unknownUsage).padStart(12)}`);
    }
  }
  const unknown = rows.reduce((a, r) => a + r.unknownUsage, 0);
  const withUsage = rows.filter(r => r.llmCalls > r.unknownUsage);
  judge(
    'AC-7f',
    rows.length === 0 || withUsage.length > 0 || unknown > 0,
    rows.length === 0
      ? '尚无真实 llm:done 数据（需先跑 --live）；聚合逻辑已由 5 条确定性断言覆盖'
      : `${withUsage.length} 个仓库拿到了 usage；另有 ${unknown} 次调用记 null（**不计入 0**）`
  );
}

// ============================================================================
// AC-3 · --attribution
// ============================================================================
function modeAttribution() {
  banner('AC-3 runId 真实覆盖（只看 M6 之后写出的记录）');
  const all = readAll();
  const modern = modernRecords(all.records);
  if (!modern.length) {
    judge('AC-3', false, '日志里还没有 M6 之后写出的记录 —— 先跑 --live 再验收本条');
    return;
  }
  const bad = modern.filter(r => !r.runId && !RUNLESS.has(String(r.stage)));
  judge('AC-3a', bad.length === 0, bad.length === 0 ? `${modern.length} 条新格式记录全部带非空 runId（或属 run-less 阶段）` : `${bad.length}/${modern.length} 条缺少 runId：${bad.slice(0, 5).map(r => `${r.ts} ${r.event} stage=${r.stage}`).join(' | ')}`);

  const poisoned = modern.filter(r => ['rejected', 'resumed', ...STEPS].includes(String(r.runId)));
  judge('AC-3b', poisoned.length === 0, poisoned.length === 0 ? 'runId 槽位零污染（不存在 rejected / resumed / 阶段名）' : `runId 被语义串污染：${JSON.stringify(poisoned.slice(0, 3))}`);

  const traceOk = modern.every(r => (r.runId ? r.traceId === `${r.runId}:${r.stage}` : r.traceId === null));
  judge('AC-3c', traceOk, 'traceId 严格等于 `${runId}:${stage}`（runId 为空则为 null）');

  const missingTrace = modern.filter(r => r.event === 'trace:missing');
  log(`  ℹ️  trace:missing ${missingTrace.length} 条（该带 runId 却没带 —— 这张列表本身就是「还有哪些调用点没穿线」的清单）`);
  const invalid = modern.filter(r => r.event === 'log:invalid-runid');
  judge('AC-3d', invalid.length === 0, invalid.length === 0 ? '无 log:invalid-runid（负向断言未触发）' : `有 ${invalid.length} 条 runId 非法值被拦下：${invalid.map(r => r.invalidRunId).join(', ')}`);
}

// ============================================================================
// AC-5 · --report <runId>
// ============================================================================
function modeReport(runId) {
  banner(`AC-5 按 runId 重建时间线：${runId}`);
  const records = readRun(runId);
  if (!records.length) {
    judge('AC-5', false, `日志里找不到 runId=${runId} 的任何事件`);
    return;
  }

  const F = require(path.resolve(PR_AGENT, 'dist/mastra/log-store.js'));
  const end = records.find(r => r.event === 'run:end');
  const target = records.find(r => r.event === 'repo:target');
  const scope = records.find(r => r.event === 'run:start');

  log('');
  log(`  run ${runId}`);
  log(`    workflow=${scope?.workflow ?? '(n/a)'}  target=${target?.repoKey ?? '(单仓库模式)'}  status=${end?.status ?? '(未终结——可能仍在挂起)'}`);
  log(`    墙钟耗时 ${end?.durationMs !== undefined ? (end.durationMs / 1000).toFixed(1) + 's' : '(不可得)'}  ·  step 成功 ${end?.stepsDone ?? '?'} / 失败 ${end?.stepsFailed ?? '?'}  ·  LLM ${end?.llmCalls ?? '?'} 次`);
  log('');
  log(`    ${'stage'.padEnd(14)} ${'耗时'.padStart(9)}  ${'llm×'.padStart(5)}  ${'tok'.padStart(9)}  备注`);

  let totalTokens = 0;
  for (const st of STEPS) {
    const started = records.find(r => r.event === 'step:start' && r.stage === st);
    const done = records.find(r => (r.event === 'step:done' || r.event === 'step:fail') && r.stage === st);
    if (!started && !done) continue;
    const ms = done?.durationMs;
    // LLM 明细：llm:done 里非心跳的那些（心跳不是一次完成的调用）
    const llmDone = records.filter(r => r.event === 'llm:done' && r.stage === st && r.heartbeat !== true);
    const starts = records.filter(r => r.event === 'llm:start' && r.stage === st).length;
    let tok = 0;
    let unknown = 0;
    for (const d of llmDone) {
      const u = F.normalizeUsage(d.usage);
      if (!u) unknown++;
      else tok += u.totalTokens ?? 0;
    }
    totalTokens += tok;
    const note = done?.event === 'step:fail' ? `失败：${String(done.error ?? '').slice(0, 60)}` : started ? '' : '(仅终态)';
    log(
      `    ${st.padEnd(14)} ${(ms !== undefined ? (ms / 1000).toFixed(1) + 's' : '-').padStart(9)}  ${String(starts).padStart(5)}  ${String(tok).padStart(9)}  ${note}`
    );
    if (unknown) log(`    ${''.padEnd(14)} ${''.padStart(9)}  ${''.padStart(5)}  ${''.padStart(9)}  ⚠️ 其中 ${unknown} 次拿不到 usage（记 null，未计入 token）`);
  }
  log(`    ${'合计'.padEnd(14)} ${''.padStart(9)}  ${''.padStart(5)}  ${String(totalTokens).padStart(9)}`);

  // ---- 断言的硬条件 ----
  judge('AC-5a', records.every(r => r.runId === runId), `取回的 ${records.length} 条**全部且仅属于**该 run`);
  judge('AC-5b', records.filter(r => r.event === 'run:end').length <= 1, `run:end ${records.filter(r => r.event === 'run:end').length} 条（≤1）`);

  const touchedDb = Object.keys(require.cache).filter(k => /better-sqlite3|@libsql|mastra[\\/]index\.js/.test(k));
  judge(
    'AC-5c',
    touchedDb.length === 0,
    touchedDb.length === 0
      ? '未加载 better-sqlite3 / @libsql / mastra/index.js —— 确实**没读 mastra.db**（M6 要消掉的就是这条手工手法）'
      : `⚠️ 报告过程加载了 DB 相关模块：${touchedDb.map(p => path.basename(p)).join(', ')}`
  );

  const startedStages = new Set(records.filter(r => r.event === 'step:start').map(r => r.stage));
  log(`  ℹ️  时间线覆盖 ${startedStages.size}/${STEPS.length} 步：${[...startedStages].join(', ')}`);
}

// ============================================================================
// AC-11 / AC-12 · 回归与工作树快照
// ============================================================================
function gitSnapshot() {
  const { spawnSync } = require('node:child_process');
  const s = spawnSync('git', ['status', '--short'], { cwd: PR_AGENT, encoding: 'utf8' });
  const b = spawnSync('git', ['branch', '--format=%(refname:short)'], { cwd: PR_AGENT, encoding: 'utf8' });
  return { status: (s.stdout || '').trim(), branches: (b.stdout || '').trim().split('\n').sort().join('|') };
}

function runRegression() {
  banner('AC-11 零回归（单测 + M5 五个验证模式）');
  const { spawnSync } = require('node:child_process');
  const jest = spawnSync('npx', ['jest', '--silent'], { cwd: PR_AGENT, encoding: 'utf8', shell: true });
  const m = /Tests:\s+(\d+) passed, (\d+) total/.exec((jest.stdout || '') + (jest.stderr || ''));
  // ⚠️ 「新增多少条」**必须算出来，不能写死** —— 写死的数字在补测后会与总数对不上
  // （2026-09-17 实况：补了 state-db 的 12 项后总数 291，而文案还写着「新增 36」）。
  // 这类「描述与事实不符」正是本卡 §2 点名要修的文档幻觉，在验证输出里同样不允许。
  const total = m ? Number(m[1]) : 0;
  const added = total ? total - BASELINE_TESTS : '?';
  judge('AC-11a', Boolean(m) && m[1] === m[2], `单测 ${m ? `${m[1]}/${m[2]}` : '(未解析到结果)'}（基线 ${BASELINE_TESTS}，本里程碑新增 ${added}）`);

  // M5 的三个秒级模式（--multi 是分钟级且写远端，不在回归里跑）
  for (const flag of ['--contract', '--dedup', '--serial']) {
    const r = spawnSync(process.execPath, [path.resolve(__dirname, 'verify-m5-multirepo.js'), flag], {
      cwd: PR_AGENT,
      encoding: 'utf8',
      timeout: 300_000,
    });
    const pass = r.status === 0;
    judge(`AC-11b${flag}`, pass, `M5 ${flag} → exit=${r.status}`);
    if (!pass) log(`      ${(r.stdout || r.stderr || '').split('\n').slice(-12).join('\n      ')}`);
  }
}

// ============================================================================
// --live：真实端到端 run
// ============================================================================
async function modeLive() {
  const targetKey = process.env.M6_LIVE_TARGET || 'local/pr-agent-e2e-b';
  const issueNumber = Number(process.env.M6_LIVE_ISSUE || 902);
  banner(`端到端真实 run：${targetKey}（stopAfterCommit，不碰远端）issue #${issueNumber}`);
  const { spawnSync } = require('node:child_process');

  const { mastra } = dist('mastra/index.js');
  const { loadRegistry, parseRepoTarget, resolveRepoEntry, repoKeyOf } = dist('mastra/adapters/repo-registry.js');

  // ⚠️ `resolveRepoEntry` 收的是 **RepoTarget 对象**（逻辑标识），不是注册表键字符串。
  //    早先这里直接传 targetKey → `assertLogicalTarget` 对字符串做 Object.entries，
  //    第 5 个字符恰好是 '/' → 误报「含本机路径」。字符串还会让 baseBranch 缺省成 'main'，
  //    与注册表的 'trunk' 矛盾。故：**从注册表取 baseBranch 组装逻辑 target，再交回校验**。
  const entry = loadRegistry()[targetKey];
  if (!entry) {
    throw new Error(`未知 repoKey：${targetKey}（已知：${Object.keys(loadRegistry()).sort().join(', ') || '(空)'}）`);
  }
  const target = parseRepoTarget(targetKey, entry.baseBranch || 'main');
  resolveRepoEntry(target); // 校验 target 只含逻辑标识，且与注册表 baseBranch 不矛盾
  // ⚠️ 只打逻辑标识 —— localPath 是「某台机器的事实」，不进日志（见 repo-registry.ts registrySummary 注释）
  log(`  解析到 target：${JSON.stringify(target)}（repoKey=${repoKeyOf(target)}，本机路径按设计不落日志）`);

  const wf = mastra.getWorkflow('dev-workflow');
  const run = await wf.createRun();
  const runId = run.runId;
  log(`  runId=${runId}`);

  const before = gitSnapshot();
  const t0 = Date.now();
  let startError;
  let result;
  try {
    result = await Promise.race([
      run.start({
        inputData: {
          issueNumber,
          issueTitle: 'docs: 在 README 新增「M6 验收」一节',
          issueBody:
            '请在 README.md 末尾新增一个名为「M6 验收」的二级标题小节，正文说明：结构化日志可用 `node scripts/verify-m6-observability.js --report <runId>` 重建时间线。' +
            '标点保持与仓库既有行文一致（半角冒号 `:` 与半角逗号 `,`）。只改 README.md，不要改动 src/ 与 test/ 下的任何文件。',
          target,
          stopAfterCommit: true,
        },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('M6_LIVE_TIMEOUT')), Number(process.env.M6_TOTAL_TIMEOUT_MS ?? 1_200_000))),
    ]);
  } catch (e) {
    startError = e;
  }
  const wall = Date.now() - t0;

  // M3 教训：run.start() 判负时 **resolve 出 {status:'failed'} 而不是 reject** ——
  // 错误必须从 startError 与 result.error 双来源取，只从 try/catch 取会得到假阴性。
  const status = startError ? 'threw' : result?.status;
  const runError = startError ? String(startError.message || startError) : result?.error ? String(result.error) : '';
  log(`  结束：status=${status}  墙钟 ${(wall / 1000).toFixed(1)}s${runError ? `  错误=${runError.slice(0, 200)}` : ''}`);

  const after = gitSnapshot();
  judge('AC-12', before.status === after.status && before.branches === after.branches, `pr-agent 工作树未被触碰（git status 与分支列表前后一致）`);

  // 落盘是**异步于** run 结束的（同步写，但最后一条可能刚写完）—— 直接读即可
  const records = readRun(runId);
  judge(`live.events`, records.length > 0, `该 runId 在日志里有 ${records.length} 条事件`);
  const end = records.find(r => r.event === 'run:end');
  judge('live.runEnd', Boolean(end), end ? `run:end status=${end.status} 耗时 ${((end.durationMs ?? 0) / 1000).toFixed(1)}s 失败步=${end.failedStage ?? '(无)'}` : '⚠️ 没有 run:end');

  return runId;
}

// ============================================================================
// 分发
// ============================================================================
async function main() {
  // 子进程模式已在上面处理过；走到这里说明是主进程
  log('');
  log('═'.repeat(78));
  log(`M6 可观测与成本 · 验收 @ ${new Date().toISOString()}`);

  if (has('--report')) {
    modeReport(argOf('--report'));
  } else if (has('--contract')) {
    modeContract();
  } else if (has('--pairing')) {
    modePairing();
  } else if (has('--interleave')) {
    await modeInterleave();
  } else if (has('--rotate')) {
    modeRotate();
  } else if (has('--failopen')) {
    modeFailopen();
  } else if (has('--cost')) {
    modeCost();
  } else if (has('--attribution')) {
    modeAttribution();
  } else if (has('--live')) {
    await modeLive();
  } else if (has('--all')) {
    const before = gitSnapshot();
    modeContract();
    modeCost();
    await modeInterleave();
    modeRotate();
    modeFailopen();
    if (process.env.M6_FAST_PAIRING !== '0') modePairing();
    modeAttribution();
    runRegression();
    const after = gitSnapshot();
    judge('AC-12', before.status === after.status && before.branches === after.branches, 'pr-agent 工作树未被触碰（`--all` 前后 git status 与分支列表一致）');
  } else {
    log('用法见文件头注释。常用：');
    log('  node scripts/verify-m6-observability.js --all');
    log('  node scripts/verify-m6-observability.js --live');
    log('  node scripts/verify-m6-observability.js --report <runId>');
    return 0;
  }

  const failed = results.filter(r => !r.ok);
  log('');
  log('═'.repeat(78));
  log(`结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    log(`❌ 未通过：${failed.map(f => f.id).join(', ')}`);
  } else if (results.length) {
    log('✅ 全部通过');
  }
  return failed.length ? 1 : 0;
}

/**
 * ⚠️ 子进程模式必须**不**落进下面的 `main()`。
 *
 * 踩过的坑（2026-09-17）：异步子进程块（`--child-interleave`）用
 * `main().then(() => process.exit(0))` 结束，而文件末尾又无条件调了一次 `main()`
 * —— 那个 main 在子进程里没有匹配的模式，会**立刻 `process.exit(0)`**，
 * 把还没跑完的异步写循环连同剩下的 3 条事件一起带走。
 * 现象是「文件里只有 1 条/run」，看起来像并发写丢了数据，其实是自己提前退出。
 */
if (!CHILD_MODE) {
  main()
    .then(code => process.exit(code))
    .catch(e => {
      console.error(e);
      log(`❌ 脚本异常：${e && e.stack ? e.stack : e}`);
      process.exit(1);
    });
}
