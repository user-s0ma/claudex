import { createInterface } from "node:readline";
import {
  CONFIG_KEYS,
  readConfig,
  resetConfig,
  writeConfig,
  type ClaudexConfig,
  type ConfigKey,
} from "./config.ts";
import { readAvailableModelsFromCache } from "./runtime-config.ts";

const LABELS: Record<ConfigKey, string> = {
  base_url: "Base URL",
  api_key: "API Key",
  model: "Model",
  effort: "Effort",
};

const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh"];

function maskValue(key: ConfigKey, value: string): string {
  if (key === "api_key" && value.length > 8) {
    return `${value.slice(0, 4)}..${value.slice(-4)}`;
  }
  return value;
}

function formatValue(key: ConfigKey, value: string | undefined): string {
  if (!value) return "\x1b[90m(not set)\x1b[0m";
  return maskValue(key, value);
}

function getChoices(key: ConfigKey): string[] | null {
  if (key === "effort") return EFFORT_OPTIONS;
  if (key === "model") {
    const models = readAvailableModelsFromCache();
    return models.length > 0 ? models : null;
  }
  return null;
}

export async function runSettingScreen(): Promise<void> {
  const write = (text: string) => process.stderr.write(text);
  const config = readConfig();
  const items: ConfigKey[] = [...CONFIG_KEYS];
  const RESET_INDEX = items.length;
  const QUIT_INDEX = items.length + 1;
  const TOTAL = items.length + 2;
  let cursor = 0;

  const render = () => {
    for (let i = 0; i < items.length; i += 1) {
      const key = items[i];
      const selected = i === cursor;
      const label = `${LABELS[key].padEnd(10)} ${formatValue(key, config[key])}`;
      write(`${selected ? "\x1b[36m> " : "\x1b[0m  "}${label}\x1b[0m\n`);
    }
    const resetSelected = cursor === RESET_INDEX;
    write(
      `${resetSelected ? "\x1b[31m> " : "\x1b[0m  "}Reset all\x1b[0m\n`,
    );
    const quitSelected = cursor === QUIT_INDEX;
    write(
      `${quitSelected ? "\x1b[36m> " : "\x1b[0m  "}Quit\x1b[0m\n`,
    );
  };

  const moveUp = () => write(`\x1b[${TOTAL}A`);
  const clearLines = () => {
    moveUp();
    for (let i = 0; i < TOTAL; i += 1) write("\x1b[2K\n");
    moveUp();
  };

  const returnToMain = () => {
    write("\x1b[1mclaudex setting\x1b[0m  \x1b[90m(↑↓ select, Enter to edit, q to quit)\x1b[0m\n\n");
    write("\x1b[?25l");
    render();
  };

  write("\x1b[1mclaudex setting\x1b[0m  \x1b[90m(↑↓ select, Enter to edit, q to quit)\x1b[0m\n\n");
  write("\x1b[?25l");
  render();

  return new Promise<void>((resolve) => {
    const stdin = process.stdin;
    if (typeof stdin.setRawMode !== "function") {
      write("\x1b[?25h");
      resolve();
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const cleanup = () => {
      stdin.removeAllListeners("data");
      stdin.setRawMode(false);
      stdin.pause();
      clearLines();
      write("\x1b[2A\x1b[J");
      write("\x1b[?25h");
      resolve();
    };

    const promptCustomInput = (key: ConfigKey, done: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      write("\x1b[?25h");

      const current = config[key] || "";
      write(`\x1b[1m${LABELS[key]}\x1b[0m`);
      if (current) write(` \x1b[90m(current: ${maskValue(key, current)})\x1b[0m`);
      write(`\n> `);

      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });

      rl.question("", (answer: string) => {
        rl.close();
        const trimmed = answer.trim();
        if (trimmed) {
          config[key] = trimmed;
        } else if (!trimmed && current) {
          delete config[key];
        }
        writeConfig(config);
        write("\x1b[2A\x1b[J");
        done();
      });
    };

    const promptSelect = (key: ConfigKey, choices: string[]) => {
      stdin.removeAllListeners("data");
      clearLines();

      const current = config[key] || "";
      let pick = choices.indexOf(current);
      if (pick < 0) pick = 0;
      const allowCustom = key === "model" || key === "effort";
      const customIdx = choices.length;
      const clearIdx = customIdx + (allowCustom ? 1 : 0);
      const totalRows = clearIdx + 1;

      write(`\x1b[1m${LABELS[key]}\x1b[0m  \x1b[90m(↑↓ select, Enter to confirm, Esc to cancel)\x1b[0m\n`);

      const renderChoices = () => {
        for (let i = 0; i < choices.length; i += 1) {
          const sel = i === pick;
          const isCurrent = choices[i] === current;
          const suffix = isCurrent ? " \x1b[90m(current)\x1b[0m" : "";
          write(`${sel ? "\x1b[36m> " : "\x1b[0m  "}${choices[i]}${suffix}\x1b[0m\n`);
        }
        if (allowCustom) {
          const customSel = pick === customIdx;
          write(`${customSel ? "\x1b[36m> " : "\x1b[0m  "}\x1b[90m(custom input)\x1b[0m\n`);
        }
        const clearSel = pick === clearIdx;
        write(`${clearSel ? "\x1b[33m> " : "\x1b[0m  "}\x1b[90m(clear)\x1b[0m\n`);
      };

      const moveUpChoices = () => write(`\x1b[${totalRows}A`);
      const clearChoiceLines = () => {
        moveUpChoices();
        for (let i = 0; i < totalRows; i += 1) write("\x1b[2K\n");
        moveUpChoices();
      };

      renderChoices();

      const applyAndReturn = (value: string | undefined) => {
        if (value !== undefined) {
          config[key] = value;
        } else {
          delete config[key];
        }
        writeConfig(config);
        returnToMain();
        stdin.on("data", onKey);
      };

      const onSelectKey = (k: string) => {
        if (k === "\x1b[A" || k === "k") {
          if (pick > 0) {
            clearChoiceLines();
            pick -= 1;
            renderChoices();
          }
        } else if (k === "\x1b[B" || k === "j") {
          if (pick < clearIdx) {
            clearChoiceLines();
            pick += 1;
            renderChoices();
          }
        } else if (k === "\r" || k === "\n") {
          stdin.removeAllListeners("data");
          clearChoiceLines();
          write("\x1b[1A\x1b[J");
          if (pick === clearIdx) {
            applyAndReturn(undefined);
          } else if (allowCustom && pick === customIdx) {
            promptCustomInput(key, () => {
              returnToMain();
              stdin.setRawMode(true);
              stdin.resume();
              stdin.setEncoding("utf8");
              stdin.on("data", onKey);
            });
            return;
          } else {
            applyAndReturn(choices[pick]);
          }
        } else if (k === "\x03" || k === "\x1b") {
          stdin.removeAllListeners("data");
          clearChoiceLines();
          write("\x1b[1A\x1b[J");
          returnToMain();
          stdin.on("data", onKey);
        }
      };

      stdin.on("data", onSelectKey);
    };

    const promptEdit = (key: ConfigKey) => {
      stdin.removeAllListeners("data");
      stdin.setRawMode(false);
      stdin.pause();
      clearLines();
      write("\x1b[?25h");

      const current = config[key] || "";
      write(`\x1b[1m${LABELS[key]}\x1b[0m`);
      if (current) write(` \x1b[90m(current: ${maskValue(key, current)})\x1b[0m`);
      write(`\n> `);

      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });

      rl.question("", (answer: string) => {
        rl.close();
        const trimmed = answer.trim();
        if (trimmed) {
          config[key] = trimmed;
        } else if (!trimmed && current) {
          delete config[key];
        }
        writeConfig(config);

        write("\x1b[2A\x1b[J");
        returnToMain();

        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        stdin.on("data", onKey);
      });
    };

    const onKey = (key: string) => {
      if (key === "\x1b[A" || key === "k") {
        if (cursor > 0) {
          clearLines();
          cursor -= 1;
          render();
        }
      } else if (key === "\x1b[B" || key === "j") {
        if (cursor < TOTAL - 1) {
          clearLines();
          cursor += 1;
          render();
        }
      } else if (key === "\r" || key === "\n") {
        if (cursor === QUIT_INDEX) {
          cleanup();
        } else if (cursor === RESET_INDEX) {
          resetConfig();
          for (const k of items) delete config[k];
          clearLines();
          render();
        } else {
          const itemKey = items[cursor];
          const choices = getChoices(itemKey);
          if (choices) {
            promptSelect(itemKey, choices);
          } else {
            promptEdit(itemKey);
          }
        }
      } else if (key === "\x03" || key === "q" || key === "\x1b") {
        cleanup();
      }
    };

    stdin.on("data", onKey);
  });
}
