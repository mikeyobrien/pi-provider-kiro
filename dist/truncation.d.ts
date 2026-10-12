import type { Message } from "@earendil-works/pi-ai";
export declare const TRUNCATION_NOTICE = "[NOTE: Your previous response was cut off due to length limits. Please continue from where you left off.]";
export declare function wasPreviousResponseTruncated(messages: Message[]): boolean;
