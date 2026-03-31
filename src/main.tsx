import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import FloatImage from "./components/FloatImage";
import "./index.css";

const Root = () => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode");

    if (mode === "float") {
        return <FloatImage />;
    }

    return <App />;
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
        <Root />
    </React.StrictMode>
);
