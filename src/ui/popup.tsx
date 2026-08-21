import { createRoot } from "react-dom/client";
import { CaptureApp } from "./CaptureApp";

createRoot(document.getElementById("root")!).render(<CaptureApp mode="popup" />);
