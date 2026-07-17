/**
 * Resolves a relative path against a base path to produce an absolute path using the URL constructor.
 * Assumes paths use '/' separators.
 * @param basePath - The absolute path serving as the starting point (e.g., /folder/file.txt).
 * @param relativePath - The path to resolve (e.g., ../other.txt).
 * @returns The resolved absolute path (e.g., /folder/other.txt).
 */
export const resolveAbsolutePath = (basePath: string, relativePath: string): string => {
	try {
		// Validate inputs
		if (!basePath || !relativePath) {
			console.warn("[Luna.resolveAbsolutePath] Invalid input:", { basePath, relativePath });
			return relativePath || basePath || "";
		}

		// Create a base URL. 'file://' is a common dummy base for path manipulation.
		// Ensure the base path ends with '/' if it represents a directory context.
		const baseDirectory = basePath.replace(/\/[^/]*$/, "/");
		
		// Validate that baseDirectory is a valid path-like string
		if (!baseDirectory || baseDirectory === "/") {
			console.warn("[Luna.resolveAbsolutePath] Invalid baseDirectory:", baseDirectory);
			return relativePath;
		}

		const baseUrl = new URL(baseDirectory, "file://");

		// Create a new URL by resolving the relative path against the base URL.
		const resolvedUrl = new URL(relativePath, baseUrl);

		// Return the pathname part of the resolved URL.
		return resolvedUrl.pathname;
	} catch (error) {
		console.error("[Luna.resolveAbsolutePath] Failed to resolve path:", { 
			basePath, 
			relativePath, 
			error: error instanceof Error ? error.message : String(error)
		});
		
		// Fallback: return relativePath as-is or attempt simple concatenation
		if (relativePath.startsWith('/')) {
			return relativePath;
		}
		
		// Simple fallback path concatenation
		const cleanBasePath = basePath?.replace(/\/[^/]*$/, "") || "";
		const cleanRelativePath = relativePath?.replace(/^\.\//, "") || "";
		
		return cleanBasePath ? `${cleanBasePath}/${cleanRelativePath}` : cleanRelativePath;
	}
};
