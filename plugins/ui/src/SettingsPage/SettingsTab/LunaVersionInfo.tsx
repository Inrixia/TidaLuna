import React, { useEffect, useState } from "react";
import { getPackage } from "@luna/lib.native";
import { LunaClientUpdate } from "./LunaClientUpdate";
import { LunaSettings } from "../../components";

export const LunaVersionInfo = React.memo(() => {
    const [pkg, setPkg] = useState<{ version?: string }>({});

    useEffect(() => {
        getPackage().then(setPkg);
    }, []);

    return (
        <div style={{ display: "flex", flexDirection: "column"}}>
            <LunaSettings>
                <div style={{ display: "flex", alignItems: "center", gap: 24, marginBottom: 8 }}>
                    <img
                        src="https://desktop.tidal.com/assets/appIcon-C2Av_5S7.png"
                        alt="TIDAL Icon"
                        style={{ width: 72, height: 72, borderRadius: 16, boxShadow: "0 2px 12px #0002" }}
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <h2>Thanks for using TIDALuna!</h2>
                        <div style={{ fontSize: 18, margin: 0 }}>
                            <strong>Version:</strong> <span style={{ color: "#31d8ff" }}>{pkg.version || "Unknown"}</span>
                        </div>
                    </div>
                </div>
                <LunaClientUpdate />
                <div style={{ padding: 2 }}>
                </div>
            </LunaSettings>
        </div>
    );
});