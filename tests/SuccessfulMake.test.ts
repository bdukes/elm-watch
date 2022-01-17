import * as fs from "fs";
import * as path from "path";

import { elmWatchCli } from "../src";
import {
  assertExitCode,
  clean,
  CursorWriteStream,
  FailReadStream,
  MemoryWriteStream,
  prependPATH,
  stringSnapshotSerializer,
} from "./Helpers";

const FIXTURES_DIR = path.join(__dirname, "fixtures");

async function run(
  fixture: string,
  args: Array<string>,
  { isTTY = true, bin }: { isTTY?: boolean; bin?: string } = {}
): Promise<string> {
  const dir = path.join(FIXTURES_DIR, fixture);
  const build = path.join(dir, "build");

  if (fs.rmSync !== undefined) {
    fs.rmSync(build, { recursive: true, force: true });
  } else if (fs.existsSync(build)) {
    fs.rmdirSync(build, { recursive: true });
  }

  const stdout = new MemoryWriteStream();
  const stderr = new CursorWriteStream();

  stdout.isTTY = isTTY;
  stderr.isTTY = isTTY;

  const exitCode = await elmWatchCli(args, {
    cwd: dir,
    env: {
      ...process.env,
      __ELM_WATCH_LOADING_MESSAGE_DELAY: "0",
      __ELM_WATCH_MAX_PARALLEL: "2",
      PATH:
        bin === undefined ? process.env.PATH : prependPATH(path.join(dir, bin)),
    },
    stdin: new FailReadStream(),
    stdout,
    stderr,
    getNow: () => new Date(0),
  });

  const stderrString = clean(stderr.getOutput());

  assertExitCode(0, exitCode, stdout.content, stderrString);
  expect(stdout.content).toBe("");

  return stderrString;
}

expect.addSnapshotSerializer(stringSnapshotSerializer);

describe("successful make", () => {
  test("standard mode", async () => {
    expect(await run("successful-make", ["make"])).toMatchInlineSnapshot(`
      ✅ Dependencies
      ✅ main⧙                                  0 ms Q |   0 ms E |   0 ms R |   0 ms P⧘

      ✅ Compilation finished in ⧙0⧘ ms.
    `);
  });

  test("--debug", async () => {
    expect(await run("successful-make", ["make", "--debug"]))
      .toMatchInlineSnapshot(`
      ✅ Dependencies
      ✅ main⧙                                  0 ms Q |   0 ms E |   0 ms R |   0 ms P⧘

      ✅ Compilation finished in ⧙0⧘ ms.
    `);
  });

  test("--optimize", async () => {
    expect(await run("successful-make", ["make", "--optimize"]))
      .toMatchInlineSnapshot(`
      ✅ Dependencies
      ✅ main⧙   87.5 KiB → 0.00 KiB (0.0%)     0 ms Q |   0 ms E |   0 ms R |   0 ms P⧘

      ✅ Compilation finished in ⧙0⧘ ms.
    `);
  });

  test("installed packages output", async () => {
    expect(
      await run("successful-make", ["make"], {
        bin: "installed-packages-output-bin",
      })
    ).toMatchInlineSnapshot(`
      ✅ Dependencies
         ● elm/html 1.0.0
         ● elm/browser 1.0.2
         ● elm/virtual-dom 1.0.2
         ● elm/time 1.0.0
         ● elm/json 1.1.3
         ● elm/url 1.0.0
         ● elm/core 1.0.5
      ✅ main⧙                                  0 ms Q |   0 ms E |   0 ms R |   0 ms P⧘

      ✅ Compilation finished in ⧙0⧘ ms.
    `);
  });

  test("CI", async () => {
    expect(
      await run("successful-make", ["make", "--optimize"], { isTTY: false })
    ).toMatchInlineSnapshot(`
      ⏳ Dependencies
      ✅ Dependencies
      ⏳ main: elm make --optimize
      🟢 main: elm make done
      ⏳ main: postprocess
      ✅ main⧙   87.5 KiB → 0.00 KiB (0.0%)     0 ms Q |   0 ms E |   0 ms R |   0 ms P⧘

      ✅ Compilation finished in ⧙0⧘ ms.
    `);
  });

  test("postprocess with elm-watch-node (cjs default)", async () => {
    expect(await run("postprocess-elm-watch-node", ["make"]))
      .toMatchInlineSnapshot(`
      ✅ Dependencies
      ✅ main⧙                                  0 ms Q |   0 ms E |   0 ms R |   0 ms P⧘

      ✅ Compilation finished in ⧙0⧘ ms⧙ (using 1 elm-watch-node worker).⧘
    `);
  });

  test("postprocess with elm-watch-node (cjs)", async () => {
    expect(await run("postprocess-elm-watch-node/cjs", ["make"]))
      .toMatchInlineSnapshot(`
      ✅ Dependencies
      ✅ main⧙                                  0 ms Q |   0 ms E |   0 ms R |   0 ms P⧘

      ✅ Compilation finished in ⧙0⧘ ms⧙ (using 1 elm-watch-node worker).⧘
    `);
  });

  test("postprocess with elm-watch-node (mjs)", async () => {
    expect(await run("postprocess-elm-watch-node/mjs", ["make"]))
      .toMatchInlineSnapshot(`
      ✅ Dependencies
      ✅ main⧙                                  0 ms Q |   0 ms E |   0 ms R |   0 ms P⧘

      ✅ Compilation finished in ⧙0⧘ ms⧙ (using 1 elm-watch-node worker).⧘
    `);
  });

  test("postprocess with elm-watch-node (mjs default)", async () => {
    expect(await run("postprocess-elm-watch-node/mjs-default", ["make"]))
      .toMatchInlineSnapshot(`
      ✅ Dependencies
      ✅ main⧙                                  0 ms Q |   0 ms E |   0 ms R |   0 ms P⧘

      ✅ Compilation finished in ⧙0⧘ ms⧙ (using 1 elm-watch-node worker).⧘
    `);
  });

  test("multiple elm.json", async () => {
    expect(await run("multiple-elm-json/config", ["make"]))
      .toMatchInlineSnapshot(`
      ✅ Dependencies
      ✅ Dependencies (2/2)
      ✅ app⧙                                   0 ms Q |   0 ms E |   0 ms R |   0 ms P⧘
      ✅ admin⧙                                 0 ms Q |   0 ms E |   0 ms R |   0 ms P⧘

      ✅ Compilation finished in ⧙0⧘ ms.
    `);
  });

  test("multiple elm-watch-node", async () => {
    expect(await run("multiple-elm-watch-node", ["make"]))
      .toMatchInlineSnapshot(`
      ✅ Dependencies
      ✅ main⧙                                  0 ms Q |   0 ms E |   0 ms R |   0 ms P⧘
      ✅ secondary⧙                             0 ms Q |   0 ms E |   0 ms R |   0 ms P⧘

      ✅ Compilation finished in ⧙0⧘ ms⧙ (using 2 elm-watch-node workers).⧘
    `);
  });

  test("no postprocess", async () => {
    expect(await run("successful-make-no-postprocess", ["make"]))
      .toMatchInlineSnapshot(`
      ✅ Dependencies
      ✅ 💣 Mine Sweeper Clone⧙                                       0 ms Q |   0 ms E⧘

      ✅ Compilation finished in ⧙0⧘ ms.
    `);
  });
});
