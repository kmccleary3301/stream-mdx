import React from "react";

// Static block consumers have no active session. StreamingMarkdown supplies its canonical activity state.
export const StreamingActivityContext = React.createContext(false);
