import { useEffect } from 'react';
import { useGroupsStore } from './stores/groupsStore';
import { connectWebSocket, joinGroup, leaveGroup } from './services/websocket';
import { Sidebar } from './components/Layout/Sidebar';
import { ChatHeader, MessageList, MessageInput } from './components/Chat';

function App() {
  const { currentGroup } = useGroupsStore();

  useEffect(() => {
    connectWebSocket();

    return () => {
      leaveGroup(currentGroup?.id || '');
    };
  }, []);

  useEffect(() => {
    if (currentGroup) {
      joinGroup(currentGroup.id);
    }
  }, [currentGroup?.id]);

  return (
    <div className="flex h-screen bg-bg-primary text-text-primary overflow-hidden">
      <div className="w-64 flex-shrink-0">
        <Sidebar />
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        <ChatHeader />
        <MessageList />
        <MessageInput />
      </div>
    </div>
  );
}

export default App;