import { createRoot } from "react-dom/client";
import { CaptureApp } from "./CaptureApp";

document.body.classList.add("popup--sidepanel", "sidepanel-app");

createRoot(document.getElementById("root")!).render(<CaptureApp mode="sidepanel" />);
