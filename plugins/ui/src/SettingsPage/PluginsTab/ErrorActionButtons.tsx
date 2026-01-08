import React from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Stack from "@mui/material/Stack";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import IconButton from "@mui/material/IconButton";
import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";

interface ErrorActionButtonsProps {
    errorMessage: string;
    pluginName: string;
    onDisable: () => void;
}

// Helper to make error messages user-friendly
const getFriendlyErrorMessage = (technicalError: string): string => {
    if (technicalError.includes("require") || technicalError.includes("not defined")) {
        return "This plugin is incompatible with your system. It may need to be updated by the developer.";
    }
    if (technicalError.includes("COULD_NOT_CONNECT") || technicalError.includes("ECONNREFUSED")) {
        return "This plugin cannot connect to its required service. Make sure the service is running.";
    }
    if (technicalError.includes("MODULE_NOT_FOUND")) {
        return "This plugin is missing required files. Try reinstalling it.";
    }
    if (technicalError.includes("file path")) {
        return "This plugin uses an outdated loading method and needs to be updated by the developer.";
    }
    return "This plugin encountered an unexpected error and cannot run.";
};

export const ErrorActionButtons = React.memo(({ errorMessage, pluginName, onDisable }: ErrorActionButtonsProps) => {
    const [showDetails, setShowDetails] = React.useState(false);
    const [copied, setCopied] = React.useState(false);

    const friendlyMessage = getFriendlyErrorMessage(errorMessage);

    const handleCopyError = () => {
        navigator.clipboard.writeText(errorMessage);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <Box sx={{ marginTop: 1 }}>
            <Alert severity="error" sx={{ marginBottom: 1 }}>
                <AlertTitle>Plugin Error</AlertTitle>
                {friendlyMessage}
            </Alert>

            <Stack direction="row" spacing={1}>
                <Button variant="contained" color="error" size="small" onClick={onDisable}>
                    Disable Plugin
                </Button>
                <Button variant="outlined" size="small" onClick={() => setShowDetails(true)}>
                    View Technical Details
                </Button>
            </Stack>

            <Dialog open={showDetails} onClose={() => setShowDetails(false)} maxWidth="md" fullWidth>
                <DialogTitle>
                    Technical Error Details
                    <IconButton
                        aria-label="close"
                        onClick={() => setShowDetails(false)}
                        sx={{
                            position: "absolute",
                            right: 8,
                            top: 8,
                        }}
                    >
                        <CloseIcon />
                    </IconButton>
                </DialogTitle>
                <DialogContent dividers>
                    <Typography variant="subtitle2" gutterBottom>
                        Plugin: {pluginName}
                    </Typography>
                    <Box
                        sx={{
                            backgroundColor: "rgba(0, 0, 0, 0.3)",
                            padding: 2,
                            borderRadius: 1,
                            fontFamily: "monospace",
                            fontSize: "0.85rem",
                            overflowX: "auto",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                        }}
                    >
                        {errorMessage}
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button startIcon={<ContentCopyIcon />} onClick={handleCopyError}>
                        {copied ? "Copied!" : "Copy Error"}
                    </Button>
                    <Button onClick={() => setShowDetails(false)}>Close</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
});
