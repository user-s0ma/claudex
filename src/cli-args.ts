export function hasEffortFlag(args: string[]): boolean {
  return args.some((arg) => arg === "--effort" || arg.startsWith("--effort="));
}

export function parseClaudexArgs(rawArgs: string[]): {
  claudeArgs: string[];
  hasSettingsArg: boolean;
  subcommand: string | null;
} {
  const claudexSubcommands = new Set(["setting"]);
  let hasSettingsArg = false;
  let subcommand: string | null = null;
  const claudeArgs: string[] = [];

  if (rawArgs.length > 0 && claudexSubcommands.has(rawArgs[0])) {
    return { claudeArgs: [], hasSettingsArg: false, subcommand: rawArgs[0] };
  }

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--settings" || arg.startsWith("--settings=")) {
      hasSettingsArg = true;
    }
    claudeArgs.push(arg);
  }

  return { claudeArgs, hasSettingsArg, subcommand };
}
