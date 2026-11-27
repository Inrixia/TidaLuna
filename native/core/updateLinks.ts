// Links an update confirmation shows (registry.ts updateQuestion): each version's source and what changed between them.
// The link building is the shared GitUrl (plugins/lib) and the update links of plugins/ui; this only finds the repository.
import { pluginUpdateSource } from "../../plugins/ui/src/SettingsPage/PluginsTab/update/pluginUpdateSource";
import { updateLinks as linksBetween, type UpdateLinks } from "../../plugins/ui/src/components/updateLinks";

type SourceInfo = { repository?: unknown; version?: string; commit?: unknown };

const side = ({ version, commit }: SourceInfo) => ({ version, commit: typeof commit === "string" ? commit : undefined });

/**
 * Links for an update of the plugin at `url`. The repository is the release's the url downloads from (where the code
 * really comes from), else the one the installed version named, else the update's (a package's commit and repository
 * are what its build says, not checked against the code). The release is linked when its tag is not the update's version
 * (`latest`, `dev`: it moves on); see updateLinks in plugins/ui.
 */
export const updateLinks = (url: string, current: SourceInfo, update: SourceInfo): UpdateLinks => {
	const { git, releaseTag } = pluginUpdateSource(url, current, update);
	return linksBetween(side(current), side(update), git, releaseTag);
};
