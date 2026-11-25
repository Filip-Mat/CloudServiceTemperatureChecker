import { useEffect, useState } from "react";
import { Button, useAuthenticator } from "@aws-amplify/ui-react";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../amplify/data/resource";
import DevicesPage from "./pages/DevicesPage";
import HomePage from "./pages/HomePage";

const client = generateClient<Schema>({ authMode: "userPool" });

export default function App() {
  const { user, signOut } = useAuthenticator();
  const accountName = user.signInDetails?.loginId || user.username;
  const [page, setPage] = useState<"home" | "devices">("home");
  const [selectedId, setSelectedId] = useState("");
  const [devices, setDevices] = useState<Schema["Devices"]["type"][]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const subscription = client.models.Devices.observeQuery().subscribe({
      next: ({ items }) => {
        setDevices([...items]);
        setError("");
      },
      error: () => setError("Could not load devices."),
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div className="dashboard-header-inner">
          <button type="button" className="dashboard-brand" onClick={() => setPage("home")}>
            <span className="dashboard-mark" aria-hidden="true">°</span>
            Temperature
          </button>
          <nav className="dashboard-nav" aria-label="Main navigation">
            <Button aria-current={page === "home" ? "page" : undefined}
              onClick={() => setPage("home")}>Home</Button>
            <Button aria-current={page === "devices" ? "page" : undefined}
              onClick={() => setPage("devices")}>Devices</Button>
          </nav>
          <div className="dashboard-account">
            <div className="dashboard-identity">
              <span>Signed in as</span>
              <strong title={accountName}>{accountName}</strong>
            </div>
            <Button className="sign-out" onClick={() => signOut()}>Sign out</Button>
          </div>
        </div>
      </header>

      <main className="dashboard-main">
        {error && <p className="dashboard-error" role="alert">{error}</p>}

        {page === "home" ? (
          <HomePage devices={devices} selectedId={selectedId} onSelect={setSelectedId}
            onOpenDevices={() => setPage("devices")} />
        ) : (
          <DevicesPage devices={devices} owner={user.userId} onViewGraph={(id) => {
            setSelectedId(id);
            setPage("home");
          }} />
        )}
      </main>
    </div>
  );
}
