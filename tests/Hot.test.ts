/**
 * @jest-environment jsdom
 */
import * as fs from "fs";
import * as path from "path";

import { ElmModule, UppercaseLetter } from "../client/client";
import { elmWatchCli } from "../src";
import { CompilationMode } from "../src/Types";
import {
  badElmBinEnv,
  clean,
  CursorWriteStream,
  FailReadStream,
  MemoryWriteStream,
  stringSnapshotSerializer,
  TEST_ENV,
} from "./Helpers";

const CONTAINER_ID = "elm-watch";
const FIXTURES_DIR = path.join(__dirname, "fixtures", "hot");

// eslint-disable-next-line no-console
console.warn = () => {
  // Disable Elm’s “Compiled in DEV mode” logs.
};

let bodyCounter = 0;

type OnIdle = (params: {
  idle: number;
  div: HTMLDivElement;
  body: HTMLBodyElement;
}) => "KeepGoing" | "Stop";

async function run({
  fixture,
  scripts,
  args = [],
  init,
  onIdle,
  expandUiImmediately = false,
  isTTY = true,
  bin,
}: {
  fixture: string;
  scripts: Array<string>;
  args?: Array<string>;
  init: (node: HTMLDivElement) => void;
  onIdle: OnIdle;
  expandUiImmediately?: boolean;
  isTTY?: boolean;
  bin?: string;
}): Promise<{
  terminal: string;
  browser: string;
  renders: string;
  div: HTMLDivElement;
}> {
  const dir = path.join(FIXTURES_DIR, fixture);
  const build = path.join(dir, "build");
  const absoluteScripts = scripts.map((script) => path.join(build, script));
  const elmWatchStuff = path.join(dir, "elm-stuff", "elm-watch-stuff.json");

  if (fs.rmSync !== undefined) {
    fs.rmSync(build, { recursive: true, force: true });
  } else if (fs.existsSync(build)) {
    fs.rmdirSync(build, { recursive: true });
  }

  if (fs.existsSync(elmWatchStuff)) {
    fs.unlinkSync(elmWatchStuff);
  }

  const stdout = new MemoryWriteStream();
  const stderr = new CursorWriteStream();

  stdout.isTTY = isTTY;
  stderr.isTTY = isTTY;

  const bodyIndex = bodyCounter + 2; // head + original body
  const body = document.createElement("body");
  const outerDiv = document.createElement("div");
  body.append(outerDiv);
  document.documentElement.append(body);
  bodyCounter++;

  const renders: Array<string> = [];

  await new Promise((resolve, reject) => {
    const loadBuiltFiles = (isReload: boolean): void => {
      delete window.Elm;
      Promise.all(
        absoluteScripts.map((script) => {
          // Copying the script does a couple of things:
          // - Avoiding require/import cache.
          // - Makes it easier to debug the tests since one can see all the outputs through time.
          // - Lets us make a few replacements for Jest.
          const newScript = script.replace(/\.(\w+)$/, `.${idle}.$1`);
          const content = fs
            .readFileSync(script, "utf8")
            .replace(/\(this\)\);\s*$/, "(window));")
            .replace(
              /^(\s*var bodyNode) = .+;/m,
              `$1 = document.documentElement.children[${bodyIndex}];`
            );
          fs.writeFileSync(newScript, content);
          return import(newScript);
        })
      ).then(() => {
        if (expandUiImmediately) {
          expandUi();
        }
        if (isReload) {
          const innerDiv = document.createElement("div");
          outerDiv.replaceChildren(innerDiv);
          body.replaceChildren(outerDiv);
          init(innerDiv);
        }
      }, reject);
    };

    let idle = -1;

    window.__ELM_WATCH_GET_NOW = () => new Date(0);
    window.__ELM_WATCH_RELOAD_PAGE = () => {
      loadBuiltFiles(true);
    };
    window.__ELM_WATCH_ON_RENDER = (targetName) => {
      withShadowRoot((shadowRoot) => {
        const element = shadowRoot.lastElementChild;

        const text =
          element instanceof Node
            ? Array.from(element.childNodes, getTextContent)
                .join(`\n${"-".repeat(80)}\n`)
                .replace(/(ws:\/\/localhost):\d{5}/g, "$1:59123")
            : `#${CONTAINER_ID} not found in:\n${
                document.documentElement.outerHTML
              } for ${args.join(", ")}. Target: ${targetName}`;

        renders.push(text);
      });
    };

    elmWatchCli(["hot", ...args], {
      cwd: dir,
      env:
        bin === undefined
          ? {
              ...process.env,
              ...TEST_ENV,
            }
          : badElmBinEnv(path.join(dir, "bad-bin", bin)),
      stdin: new FailReadStream(),
      stdout,
      stderr,
      getNow: () => new Date(0),
      onIdle: () => {
        idle++;
        switch (idle) {
          case 0: // Typecheck-only done.
            loadBuiltFiles(false);
            return "KeepGoing";
          default: {
            const result = onIdle({ idle, div: outerDiv, body });
            switch (result) {
              case "KeepGoing":
                return "KeepGoing";
              case "Stop":
                window.__ELM_WATCH_KILL_ALL();
                return "Stop";
            }
          }
        }
      },
    }).then(resolve, reject);
  });

  const stderrString = clean(stderr.getOutput());

  expect(stdout.content).toBe("");

  const lastText = renders[renders.length - 1] ?? "No renders!";

  return {
    terminal: stderrString,
    browser: lastText,
    renders: renders.join(`\n${"=".repeat(80)}\n`),
    div: outerDiv,
  };
}

const stopOnFirstSuccess: OnIdle = ({ idle }) => {
  switch (idle) {
    case 1: // Compilation done after websocket connected.
    case 2: // Client rendered ✅.
      return "KeepGoing";
    default:
      return "Stop";
  }
};

function withShadowRoot(f: (shadowRoot: ShadowRoot) => void): void {
  const shadowRoot =
    document.getElementById(CONTAINER_ID)?.shadowRoot ?? undefined;

  if (shadowRoot === undefined) {
    throw new Error(`Couldn’t find #${CONTAINER_ID}!`);
  } else {
    f(shadowRoot);
  }
}

function expandUi(): void {
  expandUiHelper(true);
}

function collapseUi(): void {
  expandUiHelper(false);
}

function expandUiHelper(wantExpanded: boolean): void {
  withShadowRoot((shadowRoot) => {
    const button = shadowRoot?.querySelector("button");
    if (button instanceof HTMLElement) {
      if (button.getAttribute("aria-expanded") !== wantExpanded.toString()) {
        button.click();
      }
    } else {
      throw new Error(`Could not button for expanding UI.`);
    }
  });
}

function switchCompilationMode(compilationMode: CompilationMode): void {
  expandUi();
  withShadowRoot((shadowRoot) => {
    const radio = shadowRoot?.querySelectorAll('input[type="radio"]')[
      switchCompilationModeHelper(compilationMode)
    ];
    if (radio instanceof HTMLInputElement) {
      radio.click();
    } else {
      throw new Error(`Could not find radio button for ${compilationMode}.`);
    }
  });
}

function assertDebugDisabled(): void {
  expandUi();
  withShadowRoot((shadowRoot) => {
    const radio = shadowRoot?.querySelector('input[type="radio"]');
    if (radio instanceof HTMLInputElement) {
      expect(radio.disabled).toBe(true);
    } else {
      throw new Error(`Could not find any radio button!`);
    }
  });
  collapseUi();
}

function switchCompilationModeHelper(compilationMode: CompilationMode): number {
  switch (compilationMode) {
    case "debug":
      return 0;
    case "standard":
      return 1;
    case "optimize":
      return 2;
  }
}

function getTextContent(element: Node): string {
  return Array.from(walkTextNodes(element))
    .join("")
    .trim()
    .replace(/\n /g, "\n");
}

function* walkTextNodes(element: Node): Generator<string, void, void> {
  if (shouldAddNewline(element)) {
    yield "\n";
  }
  for (const node of element.childNodes) {
    if (node instanceof Text) {
      yield " ";
      yield node.data;
    } else if (node instanceof HTMLInputElement && node.type === "radio") {
      yield (node.checked ? "◉" : "◯") + (node.disabled ? " (disabled)" : "");
    } else if (node instanceof HTMLButtonElement) {
      const textContent = (node.textContent ?? "").trim();
      if (textContent.length === 1) {
        yield textContent;
      } else {
        yield "\n[";
        yield textContent;
        yield "]";
      }
    } else {
      yield* walkTextNodes(node);
    }
  }
}

function shouldAddNewline(node: Node): boolean {
  switch (node.nodeName) {
    case "DIV":
    case "DT":
    case "LEGEND":
    case "LABEL":
    case "P":
    case "PRE":
      return true;
    default:
      return false;
  }
}

function htmlWithoutDebugger(body: HTMLBodyElement): string {
  if (
    body.lastElementChild instanceof HTMLDivElement &&
    body.lastElementChild.style.position === "fixed"
  ) {
    const clone = body.cloneNode(true);
    if (clone instanceof HTMLBodyElement && clone.lastElementChild !== null) {
      clone.removeChild(clone.lastElementChild);
      return clone.outerHTML;
    }
    throw new Error(
      "body.cloneNode(true) didn’t return a <body> with a lastElementChild."
    );
  } else {
    return body.outerHTML;
  }
}

function failInit(): never {
  throw new Error("Expected `init` not to be called!");
}

function click(element: HTMLElement, selector: string): void {
  const target = element.querySelector(selector);
  if (target instanceof HTMLElement) {
    target.click();
  } else {
    throw new Error(
      `Element to click is not considered clickable: ${selector} -> ${
        target === null ? "not found" : target.nodeName
      }`
    );
  }
}

async function waitOneFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

function makeTrigger(): { promise: Promise<void>; trigger: () => void } {
  let trigger = (): void => {
    throw new Error("trigger was never reassigned!");
  };
  const promise = new Promise<void>((resolve) => {
    trigger = () => {
      resolve();
    };
  });
  return { promise, trigger };
}

expect.addSnapshotSerializer(stringSnapshotSerializer);

describe("hot", () => {
  beforeEach(() => {
    document.getElementById(CONTAINER_ID)?.remove();
  });

  test("successful connect (collapsed)", async () => {
    const { terminal, renders, div } = await run({
      fixture: "basic",
      args: ["Html"],
      scripts: ["Html.js"],
      init: (node) => {
        window.Elm?.HtmlMain?.init({ node });
      },
      onIdle: stopOnFirstSuccess,
    });

    expect(terminal).toMatchInlineSnapshot(`
      ✅ Html⧙                                  0 ms Q |   0 ms E ¦   0 ms W |   0 ms I⧘

      📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

      ⧙ℹ️ 00:00:00 Web socket connected for: Html⧘
      ✅ ⧙00:00:00⧘ Everything up to date.
    `);

    expect(renders).toMatchInlineSnapshot(`
      ▼ 🔌 00:00:00 Html
      ================================================================================
      ▼ ⏳ 00:00:00 Html
      ================================================================================
      ▼ ⏳ 00:00:00 Html
      ================================================================================
      ▼ 🔌 00:00:00 Html
      ================================================================================
      ▼ ⏳ 00:00:00 Html
      ================================================================================
      ▼ ✅ 00:00:00 Html
    `);

    expect(div.outerHTML).toMatchInlineSnapshot(`<div>Hello, World!</div>`);
  });

  test("successful connect (expanded, not TTY, Worker)", async () => {
    const { terminal, renders } = await run({
      fixture: "basic",
      args: ["Worker"],
      scripts: ["Worker.js"],
      expandUiImmediately: true,
      isTTY: false,
      init: () => {
        window.Elm?.Worker?.init();
      },
      onIdle: stopOnFirstSuccess,
    });

    expect(terminal).toMatchInlineSnapshot(`
      ⏳ Dependencies
      ✅ Dependencies
      ⏳ Worker: elm make (typecheck only)
      ✅ Worker⧙     0 ms Q |   0 ms T ¦   0 ms W⧘

      📊 ⧙web socket connections:⧘ 0 ⧙(ws://0.0.0.0:59123)⧘

      ✅ ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.
      ⏳ Worker: elm make
      ✅ Worker⧙     0 ms Q |   0 ms E ¦   0 ms W |   0 ms I⧘

      📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

      ⧙ℹ️ 00:00:00 Web socket connected needing compilation of: Worker⧘
      ✅ ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.

      📊 ⧙web socket connections:⧘ 0 ⧙(ws://0.0.0.0:59123)⧘

      ⧙ℹ️ 00:00:00 Web socket disconnected for: Worker⧘
      ✅ ⧙00:00:00⧘ Everything up to date.

      📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

      ⧙ℹ️ 00:00:00 Web socket connected for: Worker⧘
      ✅ ⧙00:00:00⧘ Everything up to date.
    `);

    expect(renders).toMatchInlineSnapshot(`
      ▼ 🔌 00:00:00 Worker
      ================================================================================
      target Worker
      elm-watch %VERSION%
      web socket ws://localhost:59123
      updated 1970-01-01 00:00:00
      status Connecting
      attempt 1
      sleep 1.01 seconds
      [Connecting web socket…]
      ▲ 🔌 00:00:00 Worker
      ================================================================================
      target Worker
      elm-watch %VERSION%
      web socket ws://localhost:59123
      updated 1970-01-01 00:00:00
      status Waiting for compilation
      Compilation mode
      ◯ (disabled) Debug
      ◯ (disabled) Standard
      ◯ (disabled) Optimize
      ▲ ⏳ 00:00:00 Worker
      ================================================================================
      target Worker
      elm-watch %VERSION%
      web socket ws://localhost:59123
      updated 1970-01-01 00:00:00
      status Waiting for compilation
      Compilation mode
      ◯ (disabled) Debug
      ◉ (disabled) Standard
      ◯ (disabled) Optimize
      ▲ ⏳ 00:00:00 Worker
      ================================================================================
      ▼ 🔌 00:00:00 Worker
      ================================================================================
      target Worker
      elm-watch %VERSION%
      web socket ws://localhost:59123
      updated 1970-01-01 00:00:00
      status Connecting
      attempt 1
      sleep 1.01 seconds
      [Connecting web socket…]
      ▲ 🔌 00:00:00 Worker
      ================================================================================
      target Worker
      elm-watch %VERSION%
      web socket ws://localhost:59123
      updated 1970-01-01 00:00:00
      status Waiting for compilation
      Compilation mode
      ◯ (disabled) Debug The Elm debugger isn't supported by \`Platform.worker\` programs.
      ◉ (disabled) Standard
      ◯ (disabled) Optimize
      ▲ ⏳ 00:00:00 Worker
      ================================================================================
      target Worker
      elm-watch %VERSION%
      web socket ws://localhost:59123
      updated 1970-01-01 00:00:00
      status Successfully compiled
      Compilation mode
      ◯ (disabled) Debug The Elm debugger isn't supported by \`Platform.worker\` programs.
      ◉ Standard
      ◯ Optimize
      ▲ ✅ 00:00:00 Worker
    `);
  });

  test("successful connect (package)", async () => {
    const { terminal, renders, div } = await run({
      fixture: "package",
      args: ["Main"],
      scripts: ["Main.js"],
      init: (node) => {
        window.Elm?.Main?.init({ node });
      },
      onIdle: stopOnFirstSuccess,
    });

    expect(terminal).toMatchInlineSnapshot(`
      ✅ Main⧙                                  0 ms Q |   0 ms E ¦   0 ms W |   0 ms I⧘

      📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

      ⧙ℹ️ 00:00:00 Web socket connected for: Main⧘
      ✅ ⧙00:00:00⧘ Everything up to date.
    `);

    expect(renders).toMatchInlineSnapshot(`
      ▼ 🔌 00:00:00 Main
      ================================================================================
      ▼ ⏳ 00:00:00 Main
      ================================================================================
      ▼ ⏳ 00:00:00 Main
      ================================================================================
      ▼ 🔌 00:00:00 Main
      ================================================================================
      ▼ ⏳ 00:00:00 Main
      ================================================================================
      ▼ ✅ 00:00:00 Main
    `);

    expect(div.outerHTML).toMatchInlineSnapshot(`<div>main</div>`);
  });

  test("fail to overwrite Elm’s output with hot injection (no postprocess)", async () => {
    const { terminal, renders } = await run({
      fixture: "basic",
      args: ["Readonly"],
      scripts: ["Readonly.js"],
      init: failInit,
      onIdle: ({ idle }) => {
        switch (idle) {
          case 1:
            return "KeepGoing";
          default:
            expandUi();
            return "Stop";
        }
      },
      bin: "exit-0-write-readonly",
    });

    expect(terminal).toMatchInlineSnapshot(`
      🚨 Readonly

      ⧙-- TROUBLE WRITING OUTPUT ------------------------------------------------------⧘
      ⧙Target: Readonly⧘

      I managed to compile your code and read the generated file:

      /Users/you/project/tests/fixtures/hot/basic/build/Readonly.js

      I injected code for hot reloading, and then tried to write that back to the file
      but I encountered this error:

      EACCES: permission denied, open '/Users/you/project/tests/fixtures/hot/basic/build/Readonly.js'

      🚨 ⧙1⧘ error found

      📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

      ⧙ℹ️ 00:00:00 Web socket connected needing compilation of: Readonly⧘
      🚨 ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.
    `);

    expect(renders).toMatchInlineSnapshot(`
      ▼ 🔌 00:00:00 Readonly
      ================================================================================
      ▼ ⏳ 00:00:00 Readonly
      ================================================================================
      ▼ ⏳ 00:00:00 Readonly
      ================================================================================
      ▼ 🚨 00:00:00 Readonly
      ================================================================================
      target Readonly
      elm-watch %VERSION%
      web socket ws://localhost:59123
      updated 1970-01-01 00:00:00
      status Compilation error
      Check the terminal to see errors!
      ▲ 🚨 00:00:00 Readonly
    `);
  });

  test("fail to inject hot reload", async () => {
    const { terminal, renders } = await run({
      fixture: "basic",
      args: ["InjectError"],
      scripts: ["InjectError.js"],
      init: failInit,
      onIdle: ({ idle }) => {
        switch (idle) {
          case 1:
            return "KeepGoing";
          default:
            expandUi();
            return "Stop";
        }
      },
      bin: "exit-0-inject-error",
    });

    expect(terminal).toMatchInlineSnapshot(`
      🚨 InjectError

      ⧙-- TROUBLE INJECTING HOT RELOAD ------------------------------------------------⧘
      ⧙Target: InjectError⧘

      I tried to do some search and replace on Elm's JS output to inject
      code for hot reloading, but that didn't work out as expected!

      I tried to replace some specific code, but couldn't find it!

      I wrote that to this file so you can inspect it:

      /Users/you/project/tests/fixtures/hot/basic/build/elm-watch-InjectSearchAndReplaceNotFound-ad064e3cc0e8c86d9c08636f341b296e3a757f5914c638f11ec9541e7010c273.txt

      🚨 ⧙1⧘ error found

      📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

      ⧙ℹ️ 00:00:00 Web socket connected needing compilation of: InjectError⧘
      🚨 ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.
    `);

    expect(renders).toMatchInlineSnapshot(`
      ▼ 🔌 00:00:00 InjectError
      ================================================================================
      ▼ ⏳ 00:00:00 InjectError
      ================================================================================
      ▼ ⏳ 00:00:00 InjectError
      ================================================================================
      ▼ 🚨 00:00:00 InjectError
      ================================================================================
      target InjectError
      elm-watch %VERSION%
      web socket ws://localhost:59123
      updated 1970-01-01 00:00:00
      status Compilation error
      Check the terminal to see errors!
      ▲ 🚨 00:00:00 InjectError
    `);

    const dir = path.join(FIXTURES_DIR, "basic", "build");
    const files = fs
      .readdirSync(dir)
      .filter((name) =>
        name.startsWith("elm-watch-InjectSearchAndReplaceNotFound-")
      );

    expect(files).toHaveLength(1);

    const file = path.join(dir, files[0] as string);
    const content = fs.readFileSync(file, "utf8");

    expect(content.split("\n").slice(0, 20).join("\n")).toMatchInlineSnapshot(`
      Modifying Elm's JS output for hot reloading failed!

      ### Probe (found):
      /^var _Platform_worker =/m

      ### Regex to replace (not found!):
      /^var _Platform_worker =.+\\s*\\{\\s*return _Platform_initialize\\(/gm

      ### Replacement:
      $&"Platform.worker",

      ### Code running replacements on:
      (function(scope){
      'use strict';
      var _Platform_effectManagers = {}, _Scheduler_enqueue;

      function F(arity, fun, wrapper) {
        wrapper.a = arity;
        wrapper.f = fun;
        return wrapper;
    `);

    expect(content).toMatch("Not supposed to be here!");
  });

  describe("Parse web socket connect request url errors", () => {
    const originalWebSocket = WebSocket;

    afterEach(() => {
      window.WebSocket = originalWebSocket;
    });

    function modifyUrl(f: (url: URL) => void): void {
      class TestWebSocket extends WebSocket {
        constructor(url: URL | string) {
          if (typeof url === "string") {
            throw new Error(
              "TestWebSocket expects the url to be a URL object, not a string!"
            );
          }

          f(url);

          super(url);
        }
      }

      window.WebSocket = TestWebSocket;
    }

    test("bad url", async () => {
      modifyUrl((url) => {
        url.pathname = "nope";
      });

      const { terminal, renders } = await run({
        fixture: "basic",
        args: ["BadUrl"],
        scripts: ["BadUrl.js"],
        init: failInit,
        onIdle: () => "Stop",
      });

      expect(terminal).toMatchInlineSnapshot(`
        ✅ Dependencies
        ✅ BadUrl⧙                                           0 ms Q |   0 ms T ¦   0 ms W⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket connected with errors (see the browser for details)⧘
        ✅ ⧙00:00:00⧘ Everything up to date.
      `);

      expect(renders).toMatchInlineSnapshot(`
        ▼ 🔌 00:00:00 BadUrl
        ================================================================================
        ▼ ⏳ 00:00:00 BadUrl
        ================================================================================
        target BadUrl
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Unexpected error
        I ran into an unexpected error! This is the error message:
        I expected the web socket connection URL to start with:

        /?

        But it looks like this:

        /nope?elmWatchVersion=%25VERSION%25&targetName=BadUrl&elmCompiledTimestamp=0

        The web socket code I generate is supposed to always connect using a correct URL, so something is up here.
        ▲ ❌ 00:00:00 BadUrl
      `);
    });

    test("params decode error", async () => {
      modifyUrl((url) => {
        url.searchParams.set("elmCompiledTimestamp", "2021-12-11");
      });

      const { terminal, renders } = await run({
        fixture: "basic",
        args: ["ParamsDecodeError"],
        scripts: ["ParamsDecodeError.js"],
        init: failInit,
        onIdle: () => "Stop",
      });

      expect(terminal).toMatchInlineSnapshot(`
        ✅ Dependencies
        ✅ ParamsDecodeError⧙                                0 ms Q |   0 ms T ¦   0 ms W⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket connected with errors (see the browser for details)⧘
        ✅ ⧙00:00:00⧘ Everything up to date.
      `);

      expect(renders).toMatchInlineSnapshot(`
        ▼ 🔌 00:00:00 ParamsDecodeError
        ================================================================================
        ▼ ⏳ 00:00:00 ParamsDecodeError
        ================================================================================
        target ParamsDecodeError
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Unexpected error
        I ran into an unexpected error! This is the error message:
        I ran into trouble parsing the web socket connection URL parameters:

        At root["elmCompiledTimestamp"]:
        Expected a number
        Got: "2021-12-11"

        The URL looks like this:

        /?elmWatchVersion=%25VERSION%25&targetName=ParamsDecodeError&elmCompiledTimestamp=2021-12-11

        The web socket code I generate is supposed to always connect using a correct URL, so something is up here. Maybe the JavaScript code running in the browser was compiled with an older version of elm-watch? If so, try reloading the page.
        ▲ ❌ 00:00:00 ParamsDecodeError
      `);
    });

    test("wrong version", async () => {
      modifyUrl((url) => {
        url.searchParams.set("elmWatchVersion", "0.0.0");
      });

      const { terminal, renders } = await run({
        fixture: "basic",
        args: ["WrongVersion"],
        scripts: ["WrongVersion.js"],
        init: failInit,
        onIdle: () => "Stop",
      });

      expect(terminal).toMatchInlineSnapshot(`
        ✅ Dependencies
        ✅ WrongVersion⧙                                     0 ms Q |   0 ms T ¦   0 ms W⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket connected with errors (see the browser for details)⧘
        ✅ ⧙00:00:00⧘ Everything up to date.
      `);

      expect(renders).toMatchInlineSnapshot(`
        ▼ 🔌 00:00:00 WrongVersion
        ================================================================================
        ▼ ⏳ 00:00:00 WrongVersion
        ================================================================================
        target WrongVersion
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Unexpected error
        I ran into an unexpected error! This is the error message:
        The compiled JavaScript code running in the browser says it was compiled with:

        elm-watch 0.0.0

        But the server is:

        elm-watch %VERSION%

        Maybe the JavaScript code running in the browser was compiled with an older version of elm-watch? If so, try reloading the page.
        ▲ ❌ 00:00:00 WrongVersion
      `);
    });

    test("target not found", async () => {
      modifyUrl((url) => {
        url.searchParams.set("targetName", "nope");
      });

      const { terminal, renders } = await run({
        fixture: "basic",
        args: ["TargetNotFound"],
        scripts: ["TargetNotFound.js"],
        init: failInit,
        onIdle: () => "Stop",
      });

      expect(terminal).toMatchInlineSnapshot(`
        ✅ Dependencies
        ✅ TargetNotFound⧙                                   0 ms Q |   0 ms T ¦   0 ms W⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket connected with errors (see the browser for details)⧘
        ✅ ⧙00:00:00⧘ Everything up to date.
      `);

      expect(renders).toMatchInlineSnapshot(`
        ▼ 🔌 00:00:00 TargetNotFound
        ================================================================================
        ▼ ⏳ 00:00:00 TargetNotFound
        ================================================================================
        target TargetNotFound
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Unexpected error
        I ran into an unexpected error! This is the error message:
        The compiled JavaScript code running in the browser says it is for this target:

        nope

        But I can't find that target in elm-watch.json!

        These targets are available in elm-watch.json:

        TargetNotFound

        These targets are also available in elm-watch.json, but are not enabled (because of the CLI arguments passed):

        Html
        Worker
        Readonly
        InjectError
        BadUrl
        ParamsDecodeError
        WrongVersion
        TargetDisabled
        SendBadJson

        Maybe this target used to exist in elm-watch.json, but you removed or changed it?
        ▲ ❌ 00:00:00 TargetNotFound
      `);
    });

    test("target not found (no disabled targets)", async () => {
      modifyUrl((url) => {
        url.searchParams.set("targetName", "nope");
      });

      const { terminal, renders } = await run({
        fixture: "single",
        args: ["Main"],
        scripts: ["Main.js"],
        init: failInit,
        onIdle: () => "Stop",
      });

      expect(terminal).toMatchInlineSnapshot(`
        ✅ Dependencies
        ✅ Main⧙                                             0 ms Q |   0 ms T ¦   0 ms W⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket connected with errors (see the browser for details)⧘
        ✅ ⧙00:00:00⧘ Everything up to date.
      `);

      expect(renders).toMatchInlineSnapshot(`
        ▼ 🔌 00:00:00 Main
        ================================================================================
        ▼ ⏳ 00:00:00 Main
        ================================================================================
        target Main
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Unexpected error
        I ran into an unexpected error! This is the error message:
        The compiled JavaScript code running in the browser says it is for this target:

        nope

        But I can't find that target in elm-watch.json!

        These targets are available in elm-watch.json:

        Main

        Maybe this target used to exist in elm-watch.json, but you removed or changed it?
        ▲ ❌ 00:00:00 Main
      `);
    });

    test("target disabled", async () => {
      modifyUrl((url) => {
        url.searchParams.set("targetName", "Html");
      });

      const { terminal, renders } = await run({
        fixture: "basic",
        args: ["TargetDisabled"],
        scripts: ["TargetDisabled.js"],
        init: failInit,
        onIdle: () => "Stop",
      });

      expect(terminal).toMatchInlineSnapshot(`
        ✅ Dependencies
        ✅ TargetDisabled⧙                                   0 ms Q |   0 ms T ¦   0 ms W⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket connected with errors (see the browser for details)⧘
        ✅ ⧙00:00:00⧘ Everything up to date.
      `);

      expect(renders).toMatchInlineSnapshot(`
        ▼ 🔌 00:00:00 TargetDisabled
        ================================================================================
        ▼ ⏳ 00:00:00 TargetDisabled
        ================================================================================
        target TargetDisabled
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Unexpected error
        I ran into an unexpected error! This is the error message:
        The compiled JavaScript code running in the browser says it is for this target:

        Html

        That target does exist in elm-watch.json, but isn't enabled.

        These targets are enabled via CLI arguments:

        TargetDisabled

        These targets exist in elm-watch.json but aren't enabled:

        Html
        Worker
        Readonly
        InjectError
        BadUrl
        ParamsDecodeError
        WrongVersion
        TargetNotFound
        SendBadJson

        If you want to have this target compiled, restart elm-watch either with more CLI arguments or no CLI arguments at all!
        ▲ ❌ 00:00:00 TargetDisabled
      `);
    });

    test("send bad json", async () => {
      let idle = 0;

      class TestWebSocket extends WebSocket {
        override send(message: string): void {
          switch (idle) {
            case 2:
              idle++;
              super.send(JSON.stringify({ tag: "Nope" }));
              break;
            default:
              super.send(message);
              break;
          }
        }
      }

      window.WebSocket = TestWebSocket;

      const { terminal, renders } = await run({
        fixture: "basic",
        args: ["SendBadJson"],
        scripts: ["SendBadJson.js"],
        init: () => {
          // Do nothing.
        },
        onIdle: () => {
          idle++;
          switch (idle) {
            case 1:
              expandUi();
              withShadowRoot((shadowRoot) => {
                shadowRoot.querySelector("input")?.click();
              });
              return "KeepGoing";
            case 2:
              return "KeepGoing";
            default:
              return "Stop";
          }
        },
      });

      expect(terminal).toMatchInlineSnapshot(`
        ✅ SendBadJson⧙                           0 ms Q |   0 ms E ¦   0 ms W |   0 ms I⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket connected for: SendBadJson⧘
        ✅ ⧙00:00:00⧘ Everything up to date.
      `);

      expect(renders).toMatchInlineSnapshot(`
        ▼ 🔌 00:00:00 SendBadJson
        ================================================================================
        ▼ ⏳ 00:00:00 SendBadJson
        ================================================================================
        ▼ ⏳ 00:00:00 SendBadJson
        ================================================================================
        target SendBadJson
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Waiting for compilation
        Compilation mode
        ◯ (disabled) Debug
        ◉ (disabled) Standard
        ◯ (disabled) Optimize
        ▲ ⏳ 00:00:00 SendBadJson
        ================================================================================
        ▼ 🔌 00:00:00 SendBadJson
        ================================================================================
        ▼ ⏳ 00:00:00 SendBadJson
        ================================================================================
        ▼ ❓ 00:00:00 SendBadJson
        ================================================================================
        target SendBadJson
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Unexpected error
        I ran into an unexpected error! This is the error message:
        The compiled JavaScript code running in the browser seems to have sent a message that the web socket server cannot recognize!

        At root["tag"]:
        Expected one of these tags: "ChangedCompilationMode", "FocusedTab", "ReachedIdleState"
        Got: "Nope"

        The web socket code I generate is supposed to always send correct messages, so something is up here.
        ▲ ❌ 00:00:00 SendBadJson
      `);
    });
  });

  describe("hot reloading", () => {
    function runHotReload({ name }: { name: `${UppercaseLetter}${string}` }): {
      write: (n: number) => void;
      writeSimpleChange: () => void;
      sendToElm: (value: number) => void;
      terminate: () => void;
      lastValueFromElm: { value: unknown };
      go: (onIdle: OnIdle) => ReturnType<typeof run>;
    } {
      const fixture = "hot-reload";
      const src = path.join(FIXTURES_DIR, fixture, "src");

      const write = (n: number): void => {
        const content = fs.readFileSync(
          path.join(src, `${name}${n}.elm`),
          "utf8"
        );
        fs.writeFileSync(
          path.join(src, `${name}.elm`),
          content.replace(`module ${name}${n}`, `module ${name}`)
        );
      };

      const writeSimpleChange = (): void => {
        const content = fs.readFileSync(path.join(src, `${name}.elm`), "utf8");
        fs.writeFileSync(
          path.join(src, `${name}.elm`),
          content.replace(`hot reload`, `simple text change`)
        );
      };

      let app: ReturnType<ElmModule["init"]> | undefined;
      const lastValueFromElm: { value: unknown } = { value: undefined };

      const sendToElm = (value: number): void => {
        const send = app?.ports?.fromJs?.send;
        if (send === undefined) {
          throw new Error("Failed to find 'fromJs' send port.");
        }
        send(value);
      };

      const terminate = (): void => {
        const send = app?.ports?.terminate?.send;
        if (send === undefined) {
          throw new Error("Failed to find 'terminate' send port.");
        }
        send(null);
      };

      return {
        write,
        writeSimpleChange,
        sendToElm,
        terminate,
        lastValueFromElm,
        go: (onIdle: OnIdle) =>
          run({
            fixture,
            args: [name],
            scripts: [`${name}.js`],
            isTTY: false,
            init: (node) => {
              app = window.Elm?.[name]?.init({ node });
              if (app?.ports !== undefined) {
                const subscribe = app.ports.toJs?.subscribe;
                if (subscribe === undefined) {
                  throw new Error("Failed to find 'toJs' subscribe port.");
                }
                subscribe((value: unknown) => {
                  lastValueFromElm.value = value;
                });
              }
            },
            onIdle,
          }),
      };
    }

    test("Html", async () => {
      const { write, writeSimpleChange, go } = runHotReload({
        name: "HtmlMain",
      });

      let probe: HTMLElement | null = null;

      write(1);

      const { terminal, renders } = await go(({ idle, div }) => {
        switch (idle) {
          case 3:
            assertDebugDisabled();
            assertInit(div);
            writeSimpleChange();
            return "KeepGoing";
          case 5:
            assertHotReload(div);
            switchCompilationMode("optimize");
            write(1);
            return "KeepGoing";
          case 8:
            assertDebugDisabled();
            assertInit(div);
            writeSimpleChange();
            return "KeepGoing";
          case 10:
            assertHotReload(div);
            return "Stop";
          default:
            return "KeepGoing";
        }
      });

      expect(terminal).toMatchInlineSnapshot(`
        ⏳ Dependencies
        ✅ Dependencies
        ⏳ HtmlMain: elm make (typecheck only)
        ✅ HtmlMain⧙     0 ms Q |   0 ms T ¦   0 ms W⧘

        📊 ⧙web socket connections:⧘ 0 ⧙(ws://0.0.0.0:59123)⧘

        ✅ ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.
        ⏳ HtmlMain: elm make
        ✅ HtmlMain⧙     0 ms Q |   0 ms E ¦   0 ms W |   0 ms I⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket connected needing compilation of: HtmlMain⧘
        ✅ ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.

        📊 ⧙web socket connections:⧘ 0 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket disconnected for: HtmlMain⧘
        ✅ ⧙00:00:00⧘ Everything up to date.

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket connected for: HtmlMain⧘
        ✅ ⧙00:00:00⧘ Everything up to date.
        ⏳ HtmlMain: elm make
        ✅ HtmlMain⧙     0 ms Q |   0 ms E ¦   0 ms W |   0 ms I⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Changed /Users/you/project/tests/fixtures/hot/hot-reload/src/HtmlMain.elm⧘
        ✅ ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.
        ⏳ HtmlMain: elm make --optimize
        ⏳ HtmlMain: interrupted
        ⏳ HtmlMain: elm make --optimize
        ✅ HtmlMain⧙     0 ms Q |   0 ms E ¦   0 ms W |   0 ms I⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Changed compilation mode to "optimize" of: HtmlMain
        ℹ️ 00:00:00 Changed /Users/you/project/tests/fixtures/hot/hot-reload/src/HtmlMain.elm⧘
        ✅ ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.

        📊 ⧙web socket connections:⧘ 0 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket disconnected for: HtmlMain⧘
        ✅ ⧙00:00:00⧘ Everything up to date.

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket connected for: HtmlMain⧘
        ✅ ⧙00:00:00⧘ Everything up to date.
        ⏳ HtmlMain: elm make --optimize
        ✅ HtmlMain⧙     0 ms Q |   0 ms E ¦   0 ms W |   0 ms I⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Changed /Users/you/project/tests/fixtures/hot/hot-reload/src/HtmlMain.elm⧘
        ✅ ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.
      `);

      expect(renders).toMatchInlineSnapshot(`
        ▼ 🔌 00:00:00 HtmlMain
        ================================================================================
        ▼ ⏳ 00:00:00 HtmlMain
        ================================================================================
        ▼ ⏳ 00:00:00 HtmlMain
        ================================================================================
        ▼ 🔌 00:00:00 HtmlMain
        ================================================================================
        ▼ ⏳ 00:00:00 HtmlMain
        ================================================================================
        ▼ ✅ 00:00:00 HtmlMain
        ================================================================================
        target HtmlMain
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Successfully compiled
        Compilation mode
        ◯ (disabled) Debug The Elm debugger isn't supported by \`Html\` programs.
        ◉ Standard
        ◯ Optimize
        ▲ ✅ 00:00:00 HtmlMain
        ================================================================================
        ▼ ✅ 00:00:00 HtmlMain
        ================================================================================
        ▼ ⏳ 00:00:00 HtmlMain
        ================================================================================
        ▼ ⏳ 00:00:00 HtmlMain
        ================================================================================
        ▼ ✅ 00:00:00 HtmlMain
        ================================================================================
        target HtmlMain
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Successfully compiled
        Compilation mode
        ◯ (disabled) Debug The Elm debugger isn't supported by \`Html\` programs.
        ◉ Standard
        ◯ Optimize
        ▲ ✅ 00:00:00 HtmlMain
        ================================================================================
        target HtmlMain
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Waiting for compilation
        Compilation mode
        ◯ (disabled) Debug The Elm debugger isn't supported by \`Html\` programs.
        ◯ (disabled) Standard
        ◉ (disabled) Optimize Note: It's not always possible to hot reload optimized code, because of record field mangling. Sometimes the whole page is reloaded!
        ▲ ⏳ 00:00:00 HtmlMain
        ================================================================================
        target HtmlMain
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Waiting for compilation
        Compilation mode
        ◯ (disabled) Debug The Elm debugger isn't supported by \`Html\` programs.
        ◯ (disabled) Standard
        ◉ (disabled) Optimize Note: It's not always possible to hot reload optimized code, because of record field mangling. Sometimes the whole page is reloaded!
        ▲ ⏳ 00:00:00 HtmlMain
        ================================================================================
        target HtmlMain
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Waiting for compilation
        Compilation mode
        ◯ (disabled) Debug The Elm debugger isn't supported by \`Html\` programs.
        ◯ (disabled) Standard
        ◉ (disabled) Optimize Note: It's not always possible to hot reload optimized code, because of record field mangling. Sometimes the whole page is reloaded!
        ▲ ⏳ 00:00:00 HtmlMain
        ================================================================================
        ▼ ⚡️ 🔌 00:00:00 HtmlMain
        ================================================================================
        ▼ ⚡️ ⏳ 00:00:00 HtmlMain
        ================================================================================
        ▼ ⚡️ ✅ 00:00:00 HtmlMain
        ================================================================================
        target HtmlMain
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Successfully compiled
        Compilation mode
        ◯ (disabled) Debug The Elm debugger isn't supported by \`Html\` programs.
        ◯ Standard
        ◉ Optimize Note: It's not always possible to hot reload optimized code, because of record field mangling. Sometimes the whole page is reloaded!
        ▲ ⚡️ ✅ 00:00:00 HtmlMain
        ================================================================================
        ▼ ⚡️ ✅ 00:00:00 HtmlMain
        ================================================================================
        ▼ ⚡️ ⏳ 00:00:00 HtmlMain
        ================================================================================
        ▼ ⚡️ ⏳ 00:00:00 HtmlMain
        ================================================================================
        ▼ ⚡️ ✅ 00:00:00 HtmlMain
      `);

      function assertInit(div: HTMLDivElement): void {
        expect(div.outerHTML).toMatchInlineSnapshot(
          `<div><h1 class="probe">hot reload</h1></div>`
        );
        probe = div.querySelector(".probe");
        expect(probe).not.toBeNull();
      }

      function assertHotReload(div: HTMLDivElement): void {
        expect(div.outerHTML).toMatchInlineSnapshot(
          `<div><h1 class="probe">simple text change</h1></div>`
        );
        expect(div.querySelector(".probe")).toBe(probe);
      }
    });

    test("Application", async () => {
      const {
        write,
        writeSimpleChange,
        sendToElm,
        terminate,
        lastValueFromElm,
        go,
      } = runHotReload({ name: "Application" });

      const trigger = makeTrigger();
      let probe: HTMLElement | null = null;

      write(1);

      const { terminal, renders } = await go(({ idle, body }) => {
        switch (idle) {
          case 2:
            void assertInit(body).then(() => {
              write(2);
            });
            return "KeepGoing";
          case 5:
            void assertHotReload(body).then(() => {
              terminate();
              switchCompilationMode("debug");
              write(1);
            });
            return "KeepGoing";
          case 7:
            // Assert that the debugger appeared.
            // eslint-disable-next-line jest/no-conditional-expect
            expect(body.querySelectorAll("svg")).toHaveLength(1);
            void assertInit(body).then(() => {
              write(2);
            });
            return "KeepGoing";
          case 10:
            void assertHotReload(body).then(() => {
              terminate();
              switchCompilationMode("optimize");
              write(1);
            });
            return "KeepGoing";
          case 13:
            void assertInit(body).then(() => {
              terminate();
              write(2);
            });
            return "KeepGoing";
          case 17:
            void assertReloadForOptimize(body).then(() => {
              writeSimpleChange();
            });
            return "KeepGoing";
          case 19:
            void assertHotReloadForOptimize(body).then(() => {
              terminate();
              trigger.trigger();
            });
            return "Stop";
          default:
            return "KeepGoing";
        }
      });

      await trigger.promise;

      expect(terminal).toMatchInlineSnapshot(`
        ⏳ Dependencies
        ✅ Dependencies
        ⏳ Application: elm make (typecheck only)
        ✅ Application⧙     0 ms Q |   0 ms T ¦   0 ms W⧘

        📊 ⧙web socket connections:⧘ 0 ⧙(ws://0.0.0.0:59123)⧘

        ✅ ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.
        ⏳ Application: elm make
        ✅ Application⧙     0 ms Q |   0 ms E ¦   0 ms W |   0 ms I⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket connected needing compilation of: Application⧘
        ✅ ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.

        📊 ⧙web socket connections:⧘ 0 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket disconnected for: Application⧘
        ✅ ⧙00:00:00⧘ Everything up to date.

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket connected for: Application⧘
        ✅ ⧙00:00:00⧘ Everything up to date.
        ⏳ Application: elm make
        ✅ Application⧙     0 ms Q |   0 ms E ¦   0 ms W |   0 ms I⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Changed /Users/you/project/tests/fixtures/hot/hot-reload/src/Application.elm⧘
        ✅ ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.
        ⏳ Application: elm make --debug
        ⏳ Application: interrupted
        ⏳ Application: elm make --debug
        ✅ Application⧙     0 ms Q |   0 ms E ¦   0 ms W |   0 ms I⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Changed compilation mode to "debug" of: Application
        ℹ️ 00:00:00 Changed /Users/you/project/tests/fixtures/hot/hot-reload/src/Application.elm⧘
        ✅ ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.

        📊 ⧙web socket connections:⧘ 0 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket disconnected for: Application⧘
        ✅ ⧙00:00:00⧘ Everything up to date.

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket connected for: Application⧘
        ✅ ⧙00:00:00⧘ Everything up to date.
        ⏳ Application: elm make --debug
        ✅ Application⧙     0 ms Q |   0 ms E ¦   0 ms W |   0 ms I⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Changed /Users/you/project/tests/fixtures/hot/hot-reload/src/Application.elm⧘
        ✅ ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.
        ⏳ Application: elm make --optimize
        ✅ Application⧙     0 ms Q |   0 ms E ¦   0 ms W |   0 ms I⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Changed compilation mode to "optimize" of: Application⧘
        ✅ ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.
        ⏳ Application: elm make --optimize
        ✅ Application⧙     0 ms Q |   0 ms E ¦   0 ms W |   0 ms I⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Changed /Users/you/project/tests/fixtures/hot/hot-reload/src/Application.elm
           (1 more event)
        ℹ️ 00:00:00 Web socket connected needing compilation of: Application⧘
        ✅ ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.

        📊 ⧙web socket connections:⧘ 0 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket disconnected for: Application⧘
        ✅ ⧙00:00:00⧘ Everything up to date.

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket connected for: Application⧘
        ✅ ⧙00:00:00⧘ Everything up to date.
        ⏳ Application: elm make --optimize
        ✅ Application⧙     0 ms Q |   0 ms E ¦   0 ms W |   0 ms I⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Changed /Users/you/project/tests/fixtures/hot/hot-reload/src/Application.elm⧘
        ✅ ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.

        📊 ⧙web socket connections:⧘ 0 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket disconnected for: Application⧘
        ✅ ⧙00:00:00⧘ Everything up to date.

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Web socket connected for: Application⧘
        ✅ ⧙00:00:00⧘ Everything up to date.
        ⏳ Application: elm make --optimize
        ✅ Application⧙     0 ms Q |   0 ms E ¦   0 ms W |   0 ms I⧘

        📊 ⧙web socket connections:⧘ 1 ⧙(ws://0.0.0.0:59123)⧘

        ⧙ℹ️ 00:00:00 Changed /Users/you/project/tests/fixtures/hot/hot-reload/src/Application.elm⧘
        ✅ ⧙00:00:00⧘ Compilation finished in ⧙0⧘ ms.
      `);

      expect(renders).toMatchInlineSnapshot(`
        ▼ 🔌 00:00:00 Application
        ================================================================================
        ▼ ⏳ 00:00:00 Application
        ================================================================================
        ▼ ⏳ 00:00:00 Application
        ================================================================================
        ▼ 🔌 00:00:00 Application
        ================================================================================
        ▼ ⏳ 00:00:00 Application
        ================================================================================
        ▼ ✅ 00:00:00 Application
        ================================================================================
        ▼ ⏳ 00:00:00 Application
        ================================================================================
        ▼ ⏳ 00:00:00 Application
        ================================================================================
        ▼ ✅ 00:00:00 Application
        ================================================================================
        target Application
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Successfully compiled
        Compilation mode
        ◯ Debug
        ◉ Standard
        ◯ Optimize
        ▲ ✅ 00:00:00 Application
        ================================================================================
        target Application
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Waiting for compilation
        Compilation mode
        ◉ (disabled) Debug
        ◯ (disabled) Standard
        ◯ (disabled) Optimize
        ▲ ⏳ 00:00:00 Application
        ================================================================================
        target Application
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Waiting for compilation
        Compilation mode
        ◉ (disabled) Debug
        ◯ (disabled) Standard
        ◯ (disabled) Optimize
        ▲ ⏳ 00:00:00 Application
        ================================================================================
        target Application
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Waiting for compilation
        Compilation mode
        ◉ (disabled) Debug
        ◯ (disabled) Standard
        ◯ (disabled) Optimize
        ▲ ⏳ 00:00:00 Application
        ================================================================================
        ▼ 🔌 00:00:00 Application
        ================================================================================
        ▼ ⏳ 00:00:00 Application
        ================================================================================
        ▼ ✅ 00:00:00 Application
        ================================================================================
        ▼ ⏳ 00:00:00 Application
        ================================================================================
        ▼ ⏳ 00:00:00 Application
        ================================================================================
        ▼ ✅ 00:00:00 Application
        ================================================================================
        target Application
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Successfully compiled
        Compilation mode
        ◉ Debug
        ◯ Standard
        ◯ Optimize
        ▲ ✅ 00:00:00 Application
        ================================================================================
        target Application
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Waiting for compilation
        Compilation mode
        ◯ (disabled) Debug
        ◯ (disabled) Standard
        ◉ (disabled) Optimize Note: It's not always possible to hot reload optimized code, because of record field mangling. Sometimes the whole page is reloaded!
        ▲ ⏳ 00:00:00 Application
        ================================================================================
        target Application
        elm-watch %VERSION%
        web socket ws://localhost:59123
        updated 1970-01-01 00:00:00
        status Waiting for compilation
        Compilation mode
        ◯ (disabled) Debug
        ◯ (disabled) Standard
        ◉ (disabled) Optimize Note: It's not always possible to hot reload optimized code, because of record field mangling. Sometimes the whole page is reloaded!
        ▲ ⏳ 00:00:00 Application
        ================================================================================
        ▼ ⚡️ 🔌 00:00:00 Application
        ================================================================================
        ▼ ⚡️ ⏳ 00:00:00 Application
        ================================================================================
        ▼ ⚡️ ⏳ 00:00:00 Application
        ================================================================================
        ▼ ⚡️ 🔌 00:00:00 Application
        ================================================================================
        ▼ ⚡️ ⏳ 00:00:00 Application
        ================================================================================
        ▼ ⚡️ ✅ 00:00:00 Application
        ================================================================================
        ▼ ⚡️ ⏳ 00:00:00 Application
        ================================================================================
        ▼ ⚡️ 🔌 00:00:00 Application
        ================================================================================
        ▼ ⚡️ ⏳ 00:00:00 Application
        ================================================================================
        ▼ ⚡️ ✅ 00:00:00 Application
        ================================================================================
        ▼ ⚡️ ⏳ 00:00:00 Application
        ================================================================================
        ▼ ⚡️ ⏳ 00:00:00 Application
        ================================================================================
        ▼ ⚡️ ✅ 00:00:00 Application
      `);

      async function assertInit(body: HTMLBodyElement): Promise<void> {
        expect(htmlWithoutDebugger(body)).toMatchInlineSnapshot(`
          <body><div><h1 class="probe">Before hot reload</h1><a href="/link">Link</a><button>Button</button><pre>
          url: http://localhost/
          originalFromJs: []
          originalUrlRequested: 0
          originalUrlChanged: 0
          newFromJs: []
          newUrlRequested: 0
          newUrlChanged: 0
          browserOnClick: 0
          </pre></div></body>
        `);

        probe = body.querySelector(".probe");
        expect(probe).not.toBeNull();

        click(body, "a");
        await waitOneFrame();
        expect(htmlWithoutDebugger(body)).toMatchInlineSnapshot(`
          <body><div><h1 class="probe">Before hot reload</h1><a href="/link">Link</a><button>Button</button><pre>
          url: http://localhost/link
          originalFromJs: []
          originalUrlRequested: 1
          originalUrlChanged: 1
          newFromJs: []
          newUrlRequested: 0
          newUrlChanged: 0
          browserOnClick: 0
          </pre></div></body>
        `);

        click(body, "button");
        await waitOneFrame();
        expect(htmlWithoutDebugger(body)).toMatchInlineSnapshot(`
          <body><div><h1 class="probe">Before hot reload</h1><a href="/link">Link</a><button>Button</button><pre>
          url: http://localhost/push
          originalFromJs: []
          originalUrlRequested: 1
          originalUrlChanged: 2
          newFromJs: []
          newUrlRequested: 0
          newUrlChanged: 0
          browserOnClick: 0
          </pre></div></body>
        `);

        sendToElm(2);
        await waitOneFrame();
        expect(htmlWithoutDebugger(body)).toMatchInlineSnapshot(`
          <body><div><h1 class="probe">Before hot reload</h1><a href="/link">Link</a><button>Button</button><pre>
          url: http://localhost/push
          originalFromJs: [2]
          originalUrlRequested: 1
          originalUrlChanged: 2
          newFromJs: []
          newUrlRequested: 0
          newUrlChanged: 0
          browserOnClick: 0
          </pre></div></body>
        `);
        expect(lastValueFromElm.value).toBe(4);
      }

      async function assertHotReload(body: HTMLBodyElement): Promise<void> {
        expect(htmlWithoutDebugger(body)).toMatchInlineSnapshot(`
          <body><div><h1 class="probe">After hot reload</h1><a href="/link">Link</a><button>Button</button><pre>
          url: http://localhost/push
          originalFromJs: [2]
          originalUrlRequested: 1
          originalUrlChanged: 2
          newFromJs: []
          newUrlRequested: 0
          newUrlChanged: 0
          browserOnClick: 0
          </pre></div></body>
        `);

        expect(body.querySelector(".probe")).toBe(probe);

        click(body, "a");
        await waitOneFrame();
        expect(htmlWithoutDebugger(body)).toMatchInlineSnapshot(`
          <body><div><h1 class="probe">After hot reload</h1><a href="/link">Link</a><button>Button</button><pre>
          url: http://localhost/link
          originalFromJs: [2]
          originalUrlRequested: 1
          originalUrlChanged: 2
          newFromJs: []
          newUrlRequested: 1
          newUrlChanged: 1
          browserOnClick: 1
          </pre></div></body>
        `);

        click(body, "button");
        await waitOneFrame();
        expect(htmlWithoutDebugger(body)).toMatchInlineSnapshot(`
          <body><div><h1 class="probe">After hot reload</h1><a href="/link">Link</a><button>Button</button><pre>
          url: http://localhost/push
          originalFromJs: [2]
          originalUrlRequested: 1
          originalUrlChanged: 2
          newFromJs: []
          newUrlRequested: 1
          newUrlChanged: 2
          browserOnClick: 2
          </pre></div></body>
        `);

        sendToElm(3);
        await waitOneFrame();
        expect(htmlWithoutDebugger(body)).toMatchInlineSnapshot(`
          <body><div><h1 class="probe">After hot reload</h1><a href="/link">Link</a><button>Button</button><pre>
          url: http://localhost/push
          originalFromJs: [2]
          originalUrlRequested: 1
          originalUrlChanged: 2
          newFromJs: [3]
          newUrlRequested: 1
          newUrlChanged: 2
          browserOnClick: 2
          </pre></div></body>
        `);
        expect(lastValueFromElm.value).toBe(12);
      }

      async function assertReloadForOptimize(
        body: HTMLBodyElement
      ): Promise<void> {
        expect(htmlWithoutDebugger(body)).toMatchInlineSnapshot(`
          <body><div><h1 class="probe">After hot reload</h1><a href="/link">Link</a><button>Button</button><pre>
          url: http://localhost/
          originalFromJs: []
          originalUrlRequested: 0
          originalUrlChanged: 0
          newFromJs: []
          newUrlRequested: 0
          newUrlChanged: 0
          browserOnClick: 0
          </pre></div></body>
        `);

        expect(body.querySelector(".probe")).not.toBe(probe);

        click(body, "a");
        await waitOneFrame();
        expect(htmlWithoutDebugger(body)).toMatchInlineSnapshot(`
          <body><div><h1 class="probe">After hot reload</h1><a href="/link">Link</a><button>Button</button><pre>
          url: http://localhost/link
          originalFromJs: []
          originalUrlRequested: 0
          originalUrlChanged: 0
          newFromJs: []
          newUrlRequested: 1
          newUrlChanged: 1
          browserOnClick: 1
          </pre></div></body>
        `);

        click(body, "button");
        await waitOneFrame();
        expect(htmlWithoutDebugger(body)).toMatchInlineSnapshot(`
          <body><div><h1 class="probe">After hot reload</h1><a href="/link">Link</a><button>Button</button><pre>
          url: http://localhost/push
          originalFromJs: []
          originalUrlRequested: 0
          originalUrlChanged: 0
          newFromJs: []
          newUrlRequested: 1
          newUrlChanged: 2
          browserOnClick: 2
          </pre></div></body>
        `);

        sendToElm(3);
        await waitOneFrame();
        expect(htmlWithoutDebugger(body)).toMatchInlineSnapshot(`
          <body><div><h1 class="probe">After hot reload</h1><a href="/link">Link</a><button>Button</button><pre>
          url: http://localhost/push
          originalFromJs: []
          originalUrlRequested: 0
          originalUrlChanged: 0
          newFromJs: [3]
          newUrlRequested: 1
          newUrlChanged: 2
          browserOnClick: 2
          </pre></div></body>
        `);
        expect(lastValueFromElm.value).toBe(12);
      }

      async function assertHotReloadForOptimize(
        body: HTMLBodyElement
      ): Promise<void> {
        expect(htmlWithoutDebugger(body)).toMatchInlineSnapshot(`
          <body><div><h1 class="probe">After simple text change</h1><a href="/link">Link</a><button>Button</button><pre>
          url: http://localhost/push
          originalFromJs: []
          originalUrlRequested: 0
          originalUrlChanged: 0
          newFromJs: [3]
          newUrlRequested: 1
          newUrlChanged: 2
          browserOnClick: 2
          </pre></div></body>
        `);
        await Promise.resolve();
      }
    });
  });
});
