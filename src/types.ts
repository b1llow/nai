import type { Env } from "./env";

export type AppVariables = {
  auth: string;
};

export type AppEnv = {
  Bindings: Env;
  Variables: AppVariables;
};
