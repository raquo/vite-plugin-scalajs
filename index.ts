import { spawn, SpawnOptions } from "child_process";
import type { Logger, Plugin as VitePlugin } from "vite";

// Utility to invoke a given sbt task and fetch its output
function printSbtTask(
  task: string,
  cwd: string | undefined,
  maxAttempts: number,
  retryDelayMs: number,
  printWarning: (message: string) => void = printWarningFallback
): Promise<string> {
  return new Promise((resolve, reject) => {
    printSbtTaskImpl(resolve, reject, task, cwd, maxAttempts, maxAttempts - 1, retryDelayMs, printWarning);
  });
}

function printSbtTaskImpl(
  resolve: (value: string) => void,
  reject: (reason?: any) => void,
  task: string,
  cwd: string | undefined,
  maxAttempts: number,
  remainingAttempts: number,
  retryDelayMs: number,
  warn: (message: string) => void
): void {
  if (remainingAttempts < 0) {
    reject(`ScalaJS Vite plugin: exhausted ${maxAttempts} sbt invocation attempts without catching the cause.`);
    return;
  }

  const args = ["--batch", "-no-colors", "-Dsbt.supershell=false", `print ${task}`];
  const options: SpawnOptions = {
    cwd: cwd,
    stdio: ['ignore', 'pipe', 'inherit'],
  };

  const child = process.platform === 'win32'
    ? spawn("sbt.bat", args.map(x => `"${x}"`), { shell: true, ...options })
    : spawn("sbt", args, options);

  let fullOutput: string = '';

  child.stdout!.setEncoding('utf-8');
  child.stdout!.on('data', data => {
    fullOutput += data;
    process.stdout.write(data); // tee on my own stdout
  });

  child.on('error', err => {
    reject(new Error(`sbt invocation for Scala.js compilation could not start. Is it installed?\n${err}`));
  });
  child.on('close', code => {
    if (code !== 0) {
      let errorMessage = `sbt invocation for Scala.js compilation failed with exit code ${code}.`;
      if (fullOutput.includes("Not a valid command: --")) {
        errorMessage += "\nCause: Your sbt launcher script version is too old (<1.3.3)."
        errorMessage += "\nFix:   Re-install the latest version of sbt launcher script from https://www.scala-sbt.org/"
        reject(new Error(errorMessage));
      } else if (fullOutput.includes("sbt thinks that server is already booting")) {
        if (remainingAttempts > 0) {
          warn(`Sbt server is busy (booting), retrying in ${retryDelayMs} ms...`);
          setTimeout(
            () => {
              printSbtTaskImpl(resolve, reject, task, cwd, maxAttempts, remainingAttempts - 1, retryDelayMs, warn);
            },
            retryDelayMs
          );
        } else {
          // @TODO If we ever implement retries for different reasons, this error message could get misleading. Review then as needed.
          errorMessage += `\nCause: Sbt thinks that server is already booting. ${maxAttempts} attempts failed.`;
          reject(new Error(errorMessage));
        }
      } else {
        reject(new Error(errorMessage));
      }
    } else {
      resolve(fullOutput.trimEnd().split('\n').at(-1)!);
    }
  });
}

// By default, we use Vite's Logger, as it takes into account user's logLevel preferences etc.
// This function is a simple fallback if calling `printSbtTask` outside of Vite context.
function printWarningFallback(message: String): void {
  const yellow = '\x1b[33m';
  const reset = '\x1b[0m';
  console.log(`${yellow}${message}${reset}`);
}

export interface ScalaJSPluginOptions {
  cwd?: string,
  projectID?: string,
  task?: string,
  uriPrefix?: string,
  maxAttempts?: number,
  retryDelayMs?: number,
}

export interface ScalaJSResolverPluginOptions {
  scalaJsOutputDir: string,
  uriPrefix?: string,
}

export default scalaJsSbtPlugin;

// This version of the plugin calls sbt to find out `scalaJsOutputDir`.
export function scalaJsSbtPlugin(options: ScalaJSPluginOptions = {}): VitePlugin {
  const { cwd, projectID, uriPrefix } = options;

  const maxAttempts = options.maxAttempts ?? 1; // @TODO default to 3 in a future version?
  const retryDelayMs = options.retryDelayMs ?? 1000;

  let isDev: boolean | undefined = undefined;
  let logger: Logger | undefined = undefined;
  let scalaJsOutputDir: string | undefined = undefined;

  return {
    name: "scalajs:sbt-scalajs-plugin",

    // Vite-specific
    configResolved(resolvedConfig) {
      isDev = resolvedConfig.mode === 'development';
      logger = resolvedConfig.logger;
    },

    // standard Rollup
    async buildStart(buildOptions) {
      if (isDev === undefined || logger === undefined) {
        throw new Error("configResolved must be called before buildStart");
      }
      const resolvedLogger = logger;

      const task = options.task?.trim() || (isDev ? "fastLinkJSOutput" : "fullLinkJSOutput");
      if (["fastLinkJS", "fullLinkJS", "fastOptJS", "fullOptJS"].includes(task)) {
        // Warn about known-bad tasks to help users out
        let errorMessage = `scalaJsSbtPlugin: you provided a known unsupported task '${task}'.`;
        errorMessage += "\nFix: Provide either 'fastLinkJSOutput' or 'fullLinkJSOutput'.";
        errorMessage += "\n     One of those is probably what you want.";
        errorMessage += "\n     By default, the plugin chooses between them depending on NODE_ENV.";
        errorMessage += "\nOr:  Provide a custom task that returns the Scala.js output directory,";
        errorMessage += "\n     either as a java.io.File, or as a String with its absolute path.";
        throw new Error(errorMessage);
      }
      const projectTask = projectID ? `${projectID}/${task}` : task;
      scalaJsOutputDir = await printSbtTask(
        projectTask, cwd, maxAttempts, retryDelayMs,
        message => resolvedLogger.warn(message)
      );
    },

    // standard Rollup
    resolveId(moduleId, importer, resolveOptions) {
      return resolveModuleId(
        moduleId,
        uriPrefix,
        scalaJsOutputDir,
        "scalaJsSbtPlugin: buildStart must be called before resolveId"
      );
    },
  };
}

// This version of the plugin does not call sbt, it only resolves the scala.js modules to a known `scalaJsOutputDir`.
export function scalaJsResolverPlugin(options: ScalaJSResolverPluginOptions): VitePlugin {
  return {
    name: "scalajs:resolver-plugin",

    // standard Rollup
    resolveId(moduleId, importer, resolveOptions) {
      return resolveModuleId(
        moduleId,
        options?.uriPrefix,
        options?.scalaJsOutputDir,
        "You must provide a `scalaJsOutputDir` option to scalaJsResolverPlugin (or use scalaJsSbtPlugin, which calls sbt to find it)."
      );
    },
  };
}

// Returns null if the module id is not relevant to scala.js vite plugin.
// Throws if scalaJsOutputDir is not defined.
export function resolveModuleId(
  moduleId: String,
  uriPrefix: string | undefined,
  scalaJsOutputDir: string | undefined,
  errorMessageIfNoOutputDir: string
): string | null {
  if (scalaJsOutputDir === undefined) {
    throw new Error(errorMessageIfNoOutputDir);
  }

  const fullUriPrefix = uriPrefix ? (uriPrefix + ':') : 'scalajs:';

  if (!moduleId.startsWith(fullUriPrefix)) {
    return null;
  }

  const path = moduleId.substring(fullUriPrefix.length);

  return `${scalaJsOutputDir}/${path}`;
}
