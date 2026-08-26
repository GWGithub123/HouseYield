import React from 'react';

interface PortfolioExpandedPropertyModalProps {
  isOpen: boolean;
  onClose: () => void;
  [key: string]: any;
}

const PortfolioExpandedPropertyModal: React.FC<PortfolioExpandedPropertyModalProps> = ({
  isOpen,
  onClose,
}) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl p-8 max-w-lg w-full mx-4">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-xl"
        >
          ✕
        </button>
        <h2 className="text-xl font-semibold text-gray-800">Property Details</h2>
        <p className="mt-2 text-gray-500 text-sm">Loading property details...</p>
      </div>
    </div>
  );
};

export default PortfolioExpandedPropertyModal;
