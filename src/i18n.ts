// Language of human-facing text (tool labels). Resolution order:
// OMOMP_LANG → LC_ALL / LC_MESSAGES / LANG → English.
// (The agent-dir omomp file's `omomp-lang` section is intentionally not read:
// the language setting lives in omp-config's omp.settings and reaches plugins
// as OMOMP_LANG.)
export type Language = "en" | "zh";

export function language(): Language {
	const explicit = process.env.OMOMP_LANG?.trim().toLowerCase();
	if (explicit === "en" || explicit === "zh") return explicit;
	for (const key of ["LC_ALL", "LC_MESSAGES", "LANG"] as const) {
		const value = process.env[key]?.trim();
		if (value) return value.toLowerCase().startsWith("zh") ? "zh" : "en";
	}
	return "en";
}

/** The text for the current language; English comes first at each use site. */
export function tr(en: string, zh: string): string {
	return language() === "zh" ? zh : en;
}
