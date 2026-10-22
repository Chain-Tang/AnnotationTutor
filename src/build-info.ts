declare const __ATL_BUILD_ID__: string;
declare const __ATL_BUILD_TIME__: string;

export const BUILD_ID = typeof __ATL_BUILD_ID__ === "string" ? __ATL_BUILD_ID__ : "development";
export const BUILD_TIME = typeof __ATL_BUILD_TIME__ === "string" ? __ATL_BUILD_TIME__ : "development";
