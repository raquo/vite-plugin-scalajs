import { spawn, SpawnOptions } from "child_process";
import type { Plugin as VitePlugin } from "vite";

// Utility to invoke a given sbt task and fetch its output
function printSbtTask(
  task: string,
  cwd: string | undefined,
  maxAttempts: number,
  retryDelayMs: number
): Promise<string> {
  return printSbtTaskImpl(task, cwd, maxAttempts, maxAttempts - 1, retryDelayMs);
}

function printSbtTaskImpl(
  task: string,
  cwd: string | undefined,
  maxAttempts: number,
  remainingAttempts: number,
  retryDelayMs: number
): Promise<string> {
  if (remainingAttempts < 0) {
    return Promise.reject(`ScalaJS Vite plugin: exhausted ${maxAttempts} sbt invocation attempts without catching the cause.`);
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

  return new Promise((resolve, reject) => {
    child.on('error', err => {
      reject(new Error(`sbt invocation for Scala.js compilation could not start. Is it installed? \n${err}`));
    });
    child.on('close', code => {
      if (code !== 0) {
        let errorMessage = `sbt invocation for Scala.js compilation failed with exit code ${code}.`;
        if (fullOutput.includes("Not a valid command: --")) {
          errorMessage += "\nCause: Your sbt launcher script version is too old (<1.3.3)."
          errorMessage += "\nFix: Re-install the latest version of sbt launcher script from https://www.scala-sbt.org/"
          reject(new Error(errorMessage));
        } else if (fullOutput.includes("sbt thinks that server is already booting")) {
          if (remainingAttempts > 0) {
            printWarning(`Sbt server is busy (booting), retrying in ${retryDelayMs} ms...`);
            setTimeout(
              () => {
                printSbtTaskImpl(task, cwd, maxAttempts, remainingAttempts -= 1, retryDelayMs)
                  .then(resolve)
                  .catch(reject);
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
  });
}

function printWarning(message: String): void {
  const yellow = '\x1b[33m';
  const reset = '\x1b[0m';
  console.log(`${yellow}${message}${reset}`);
}

export interface ScalaJSPluginOptions {
  cwd?: string,
  projectID?: string,
  uriPrefix?: string,
  maxAttempts?: number,
  retryDelayMs?: number,
}

export default function scalaJSPlugin(options: ScalaJSPluginOptions = {}): VitePlugin {
  const { cwd, projectID, uriPrefix } = options;

  const maxAttempts = options.maxAttempts ?? 1; // @TODO default to 3 in a future version?
  const retryDelayMs = options.retryDelayMs ?? 1000;

  const fullURIPrefix = uriPrefix ? (uriPrefix + ':') : 'scalajs:';

  let isDev: boolean | undefined = undefined;
  let scalaJSOutputDir: string | undefined = undefined;

  return {
    name: "scalajs:sbt-scalajs-plugin",

    // Vite-specific
    configResolved(resolvedConfig) {
      isDev = resolvedConfig.mode === 'development';
    },

    // standard Rollup
    async buildStart(options) {
      if (isDev === undefined)
        throw new Error("configResolved must be called before buildStart");

      const task = isDev ? "fastLinkJSOutput" : "fullLinkJSOutput";
      const projectTask = projectID ? `${projectID}/${task}` : task;
      scalaJSOutputDir = await printSbtTask(projectTask, cwd, maxAttempts, retryDelayMs);
    },

    // standard Rollup
    resolveId(source, importer, options) {
      if (scalaJSOutputDir === undefined)
        throw new Error("buildStart must be called before resolveId");

      if (!source.startsWith(fullURIPrefix))
        return null;
      const path = source.substring(fullURIPrefix.length);

      return `${scalaJSOutputDir}/${path}`;
    },
  };
}
