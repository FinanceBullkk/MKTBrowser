import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { WindowsProcessQueryWorker } from "./windows-process-query-worker.ts";

const responder = `
  let count = 0;
  require('node:readline').createInterface({ input: process.stdin }).on('line', () => {
    process.stdout.write(JSON.stringify([{ pid: ++count, commandLine: 'fresh' }]) + '\\n');
  });
`;

function fixture(scripts = [responder], idleMs = 10_000) {
  const children: ReturnType<typeof spawn>[] = [];
  const worker = new WindowsProcessQueryWorker(() => {
    const child = spawn(
      process.execPath,
      ["-e", scripts[Math.min(children.length, scripts.length - 1)]!],
      {
        stdio: "pipe",
        windowsHide: true,
      },
    );
    children.push(child);
    return child;
  }, idleMs);
  return { worker, children };
}

test("reuses one shell while issuing distinct fresh serialized process snapshots", async () => {
  const { worker, children } = fixture();
  try {
    const [first, second, third] = await Promise.all([
      worker.query(2000),
      worker.query(2000),
      worker.query(2000),
    ]);
    assert.deepEqual(first, [{ pid: 1, commandLine: "fresh" }]);
    assert.deepEqual(second, [{ pid: 2, commandLine: "fresh" }]);
    assert.deepEqual(third, [{ pid: 3, commandLine: "fresh" }]);
    assert.equal(
      children.length,
      1,
      "Repeated shell startup must not consume the readiness budget",
    );
  } finally {
    worker.dispose();
  }
});

test("handles fragmented UTF-8 frames and an explicitly empty successful query", async () => {
  const { worker } = fixture([
    `
    let count = 0;
    require('node:readline').createInterface({ input: process.stdin }).on('line', () => {
      const body = Buffer.from(++count === 1 ? '[{"pid":1,"commandLine":"h\\u1ed3"}]\\r\\n' : '[]\\n');
      for (const byte of body) process.stdout.write(Buffer.from([byte]));
    });
  `,
  ]);
  try {
    assert.deepEqual(await worker.query(2000), [{ pid: 1, commandLine: "h\u1ed3" }]);
    assert.deepEqual(await worker.query(2000), []);
  } finally {
    worker.dispose();
  }
});

for (const [label, body] of [
  ["malformed", "not-json\\n"],
  ["error", "!error\\n"],
  ["non-array", "{}\\n"],
  ["extra-frame", "[]\\n[]\\n"],
] as const) {
  test(`rejects ${label} output, retires the shell and permits a fresh query`, async () => {
    const { worker, children } = fixture([
      `process.stdin.once('data', () => process.stdout.write('${body}'));`,
      responder,
    ]);
    try {
      await assert.rejects(worker.query(2000), /invalid frame/);
      assert.equal(children[0]!.killed, true);
      assert.deepEqual(await worker.query(2000), [{ pid: 1, commandLine: "fresh" }]);
      assert.equal(children.length, 2);
    } finally {
      worker.dispose();
    }
  });
}

test("rejects output exceeding the bound instead of accepting an incomplete table", async () => {
  const { worker } = fixture([
    "process.stdin.once('data', () => process.stdout.write('x'.repeat(1048577)));",
  ]);
  try {
    await assert.rejects(worker.query(2000), /exceeded its bound/);
  } finally {
    worker.dispose();
  }
});

test("retires a timed-out shell so its late snapshot cannot satisfy the next request", async () => {
  const { worker, children } = fixture([
    "process.stdin.once('data', () => setTimeout(() => process.stdout.write('[{\"pid\":999}]\\n'), 1000));",
    responder,
  ]);
  try {
    await assert.rejects(worker.query(100), (error: unknown) => {
      assert.equal((error as { killed: boolean }).killed, true);
      return true;
    });
    assert.equal(children[0]!.killed, true);
    assert.deepEqual(await worker.query(2000), [{ pid: 1, commandLine: "fresh" }]);
  } finally {
    worker.dispose();
  }
});

test("queued requests expire independently without invalidating the active query", async () => {
  const { worker } = fixture([
    "process.stdin.on('data', () => setTimeout(() => process.stdout.write('[]\\n'), 250));",
  ]);
  try {
    const active = worker.query(2000);
    await assert.rejects(worker.query(50), /timed out/);
    assert.deepEqual(await active, []);
  } finally {
    worker.dispose();
  }
});

test("fails closed on child exit and spawn failure", async () => {
  const { worker } = fixture(["process.exit(0)"]);
  try {
    await assert.rejects(worker.query(2000), /exited/);
  } finally {
    worker.dispose();
  }
  const missing = new WindowsProcessQueryWorker(() => {
    throw new Error("missing shell");
  });
  try {
    await assert.rejects(missing.query(2000), /Could not start/);
  } finally {
    missing.dispose();
  }
});

test("retires after idle and rejects all outstanding requests on disposal", async () => {
  const { worker, children } = fixture([responder], 30);
  assert.deepEqual(await worker.query(2000), [{ pid: 1, commandLine: "fresh" }]);
  await once(children[0]!, "exit");
  assert.deepEqual(await worker.query(2000), [{ pid: 1, commandLine: "fresh" }]);
  assert.equal(children.length, 2);
  const pending = [worker.query(2000), worker.query(2000)];
  const rejected = Promise.all(pending.map((query) => assert.rejects(query, /disposed/)));
  worker.dispose();
  await rejected;
  await assert.rejects(worker.query(2000), /disposed/);
});
