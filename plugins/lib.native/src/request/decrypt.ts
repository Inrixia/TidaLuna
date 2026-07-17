import type { TidalManifest } from "@luna/lib";
import { createDecipheriv } from "crypto";

// Do not change this
const mastKey = "UIlTTEMmmLfGowo/UC60x2H45W6MdGgTRfo/umg4754=";
const mastKeyBuffer = Buffer.from(mastKey, "base64");

type DecryptedKey = {
	key: Buffer;
	nonce: Buffer;
};

const decryptKeyId = (keyId: string): DecryptedKey => {
	// Decode the base64 strings to buffers
	const keyIdBuffer = Buffer.from(keyId, "base64");

	// Get the IV from the first 16 bytes of the securityToken
	const iv = keyIdBuffer.subarray(0, 16);
	const keyIdEnc = keyIdBuffer.subarray(16);

	// Initialize decryptor
	const decryptor = createDecipheriv("aes-256-cbc", Uint8Array.from(mastKeyBuffer), Uint8Array.from(iv));

	// Decrypt the security token
	const keyIdDec = decryptor.update(Uint8Array.from(keyIdEnc));

	// Get the audio stream decryption key and nonce from the decrypted security token
	const key = keyIdDec.subarray(0, 16);
	const nonce = keyIdDec.subarray(16, 24);

	return { key, nonce };
};

// Extend nonce to 16 bytes (nonce + counter)
const makeDecipheriv = ({ key, nonce }: DecryptedKey) => {
	const iv = new Uint8Array([...nonce, ...new Uint8Array(8)]);
	return createDecipheriv("aes-128-ctr", Uint8Array.from(key), iv);
};

export const makeDecipher = (manifest?: TidalManifest) => {
	if (manifest === undefined) return;
	switch (manifest.encryptionType) {
		case "OLD_AES": {
			return makeDecipheriv(decryptKeyId(manifest.keyId));
		}
		case "NONE": {
			return undefined;
		}
		default: {
			throw new Error(`Unexpected manifest encryption type ${manifest.encryptionType}`);
		}
	}
};
