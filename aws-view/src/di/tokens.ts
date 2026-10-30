import { InjectionToken } from "@needle-di/core";
import type * as vscode from "vscode";

export const EXTENSION_CONTEXT = new InjectionToken<vscode.ExtensionContext>("ExtensionContext");
export const LOGGER = new InjectionToken<vscode.LogOutputChannel>("Logger");
