/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** ShowMD Path - Path to the showmd binary. Leave empty to auto-detect it on PATH. */
  "showmdPath"?: string,
  /** Port - Preferred port to check first for ShowMD. ShowMD running on other ports is also found. */
  "port": string,
  /** Open in Running ShowMD - Open files in the ShowMD that's already running instead of starting another. */
  "reuseServer": boolean
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `open` command */
  export type Open = ExtensionPreferences & {}
  /** Preferences accessible in the `manage-server` command */
  export type ManageServer = ExtensionPreferences & {}
  /** Preferences accessible in the `edit-settings` command */
  export type EditSettings = ExtensionPreferences & {}
  /** Preferences accessible in the `browse-skills` command */
  export type BrowseSkills = ExtensionPreferences & {}
  /** Preferences accessible in the `open-selected` command */
  export type OpenSelected = ExtensionPreferences & {}
  /** Preferences accessible in the `menu-bar` command */
  export type MenuBar = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `open` command */
  export type Open = {}
  /** Arguments passed to the `manage-server` command */
  export type ManageServer = {}
  /** Arguments passed to the `edit-settings` command */
  export type EditSettings = {}
  /** Arguments passed to the `browse-skills` command */
  export type BrowseSkills = {}
  /** Arguments passed to the `open-selected` command */
  export type OpenSelected = {}
  /** Arguments passed to the `menu-bar` command */
  export type MenuBar = {}
}

