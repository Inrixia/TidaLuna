import React from "react";
import TextField from "@mui/material/TextField";
import InputAdornment from "@mui/material/InputAdornment";
import SearchIcon from "@mui/icons-material/Search";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";

interface PluginSearchBarProps {
    searchTerm: string;
    onSearchChange: (value: string) => void;
    totalCount: number;
    filteredCount: number;
}

export const PluginSearchBar = React.memo(({ searchTerm, onSearchChange, totalCount, filteredCount }: PluginSearchBarProps) => {
    return (
        <Box
            sx={{
                marginBottom: 2,
                padding: 2.5,
                borderRadius: 2,
                backgroundColor: "rgba(0, 0, 0, 0.2)",
                border: "1px solid rgba(255, 255, 255, 0.08)",
            }}
        >
            <TextField
                fullWidth
                variant="outlined"
                placeholder="Search plugins by name, author, or description..."
                value={searchTerm}
                onChange={(e) => onSearchChange(e.target.value)}
                InputProps={{
                    startAdornment: (
                        <InputAdornment position="start">
                            <SearchIcon sx={{ fontSize: 28, opacity: 0.7 }} />
                        </InputAdornment>
                    ),
                }}
                sx={{
                    "& .MuiOutlinedInput-root": {
                        backgroundColor: "rgba(0, 0, 0, 0.3)",
                        borderRadius: 2,
                        fontSize: "1.05rem",
                        "& fieldset": {
                            borderColor: "rgba(255, 255, 255, 0.15)",
                            borderWidth: 2,
                        },
                        "&:hover fieldset": {
                            borderColor: "rgba(255, 255, 255, 0.3)",
                        },
                        "&.Mui-focused fieldset": {
                            borderColor: "rgba(99, 102, 241, 0.6)",
                            borderWidth: 2,
                        },
                    },
                    "& .MuiInputBase-input": {
                        padding: "14px 16px",
                    },
                }}
            />
            {searchTerm && (
                <Typography
                    variant="caption"
                    sx={{
                        marginTop: 1.5,
                        display: "block",
                        opacity: 0.8,
                        fontSize: "0.9rem",
                        fontWeight: 500,
                    }}
                >
                    Showing {filteredCount} of {totalCount} plugins
                </Typography>
            )}
        </Box>
    );
});
