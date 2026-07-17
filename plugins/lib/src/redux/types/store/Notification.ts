export type Severity = "DEBUG" | "ERROR" | "INFO" | "WARN";
export type Data = Record<string, any> | ServiceWorkerRegistration;
export type Category = "MUTE" | "NETWORK" | "OTHER" | "PLAYBACK";
export type Notification = {
	category: Category;
	data: Data;
	id: number;
	message: string;
	severity: Severity;
};
export type Message = Partial<Notification> | undefined;
