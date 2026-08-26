import React from 'react';

const TopHeader = ({ children }: { children: React.ReactNode }) => (
  <header className="w-full border-b bg-white">
    <div className="px-6 py-1.5">{children}</div>
  </header>
);

export default TopHeader;