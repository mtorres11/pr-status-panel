// In-memory stand-ins for the editor ports.

import type { Settings } from "../src/ports";

/** Settings backed by two maps: effective values and user-level values ("section.key" outside prStatus). */
export function fakeSettings(effective: Record<string, unknown> = {}, user: Record<string, unknown> = {}) {
  const updates: [string, unknown][] = [];
  const settings: Settings = {
    get: <T>(key: string, fallback: T) => (key in effective ? (effective[key] as T) : fallback),
    user: <T>(key: string, fallback: T, section = "prStatus") => {
      const k = section === "prStatus" ? key : `${section}.${key}`;
      return k in user && user[k] !== null ? (user[k] as T) : fallback;
    },
    update: async (key, value) => {
      updates.push([key, value]);
      effective[key] = value;
    },
  };
  return { settings, updates };
}
