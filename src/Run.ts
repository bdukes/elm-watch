import { compile } from "./Compile";
import * as ElmToolingJson from "./ElmToolingJson";
import * as Errors from "./Errors";
import { Env } from "./Helpers";
import type { Logger } from "./Logger";
import { isNonEmptyArray, NonEmptyArray } from "./NonEmptyArray";
import { Cwd } from "./PathHelpers";
import * as State from "./State";
import type { CliArg, CompilationMode, RunMode } from "./Types";

export async function run(
  cwd: Cwd,
  env: Env,
  logger: Logger,
  runMode: RunMode,
  args: Array<CliArg>
): Promise<number> {
  const parseResult = ElmToolingJson.findReadAndParse(cwd);

  switch (parseResult.tag) {
    case "ReadAsJsonError":
      logger.errorTemplate(
        Errors.readElmToolingJsonAsJson(
          parseResult.elmToolingJsonPath,
          parseResult.error
        )
      );
      return 1;

    case "DecodeError":
      logger.errorTemplate(
        Errors.decodeElmToolingJson(
          parseResult.elmToolingJsonPath,
          parseResult.error
        )
      );
      return 1;

    case "ElmToolingJsonNotFound":
      logger.errorTemplate(Errors.elmToolingJsonNotFound(cwd, args));
      return 1;

    case "Parsed": {
      const parseArgsResult = parseArgs(runMode, args);

      switch (parseArgsResult.tag) {
        case "BadArgs":
          logger.errorTemplate(
            Errors.badArgs(
              cwd,
              parseResult.elmToolingJsonPath,
              args,
              parseArgsResult.badArgs
            )
          );
          return 1;

        case "DebugOptimizeForHot":
          logger.errorTemplate(Errors.debugOptimizeForHot());
          return 1;

        case "DebugOptimizeClash":
          logger.errorTemplate(Errors.debugOptimizeClash());
          return 1;

        case "Success": {
          const { outputs } = parseResult.config;
          const unknownOutputs = parseArgsResult.outputs.filter(
            (arg) => !Object.prototype.hasOwnProperty.call(outputs, arg)
          );

          if (isNonEmptyArray(unknownOutputs)) {
            logger.errorTemplate(
              Errors.unknownOutputs(
                parseResult.elmToolingJsonPath,
                // The decoder validates that there’s at least one output.
                Object.keys(outputs) as NonEmptyArray<string>,
                unknownOutputs
              )
            );
            return 1;
          }

          const initStateResult = State.init({
            cwd,
            runMode,
            compilationMode: parseArgsResult.compilationMode,
            elmToolingJsonPath: parseResult.elmToolingJsonPath,
            config: parseResult.config,
            enabledOutputs: isNonEmptyArray(parseArgsResult.outputs)
              ? new Set(parseArgsResult.outputs)
              : new Set(Object.keys(outputs)),
          });

          switch (initStateResult.tag) {
            // istanbul ignore next
            case "NoCommonRoot":
              logger.errorTemplate(Errors.noCommonRoot(initStateResult.paths));
              return 1;

            case "State":
              return compile(env, logger, initStateResult.state);
          }
        }
      }
    }
  }
}

type ParseArgsResult =
  | {
      tag: "BadArgs";
      badArgs: NonEmptyArray<CliArg>;
    }
  | {
      tag: "Success";
      compilationMode: CompilationMode;
      outputs: Array<string>;
    }
  | { tag: "DebugOptimizeClash" }
  | { tag: "DebugOptimizeForHot" };

function parseArgs(runMode: RunMode, args: Array<CliArg>): ParseArgsResult {
  let debug = false;
  let optimize = false;
  const badArgs: Array<CliArg> = [];
  const outputs: Array<string> = [];

  for (const arg of args) {
    switch (arg.theArg) {
      case "--debug":
        debug = true;
        break;

      case "--optimize":
        optimize = true;
        break;

      default:
        if (ElmToolingJson.isValidOutputName(arg.theArg)) {
          outputs.push(arg.theArg);
        } else {
          badArgs.push(arg);
        }
    }
  }

  switch (runMode) {
    case "hot":
      if (debug || optimize) {
        return { tag: "DebugOptimizeForHot" };
      }
      break;

    case "make":
      if (debug && optimize) {
        return { tag: "DebugOptimizeClash" };
      }
      break;
  }

  if (isNonEmptyArray(badArgs)) {
    return {
      tag: "BadArgs",
      badArgs,
    };
  }

  return {
    tag: "Success",
    compilationMode: debug ? "debug" : optimize ? "optimize" : "standard",
    outputs,
  };
}
