import { findModuleProperty } from "@luna/core";

type TidalCredentials = {
	clientId: string;
	clientUniqueKey: string;
	expires: number;
	grantedScopes: string[];
	requestedScopes: string[];
	token: string;
	userId: string;
};

type GetCredentials = () => Promise<TidalCredentials>;
// A constant so findModuleProperty's memo hits, an inline selector searches every module on each call
const isGetCredentials = (key: unknown, value: unknown) => key === "getCredentials" && typeof value === "function";
export const getCredentials = async () => {
	const getCredentials = await findModuleProperty<GetCredentials>(isGetCredentials)?.value;
	if (!getCredentials) throw new Error("Could not find Tidal credentials module");
	const creds = await getCredentials?.();
	if (!creds) throw new Error(`getCredentials returned ${typeof creds}!`);
	return creds;
};
