import { useState, useEffect } from 'react';
import gmailService, { GmailMessage } from '../services/gmailService';

export interface MessagingModalProps {
  isOpen: boolean;
  onClose: () => void;
  tenant: {
    name: string;
    unit: string;
    email?: string;
    messages: Array<{
      id: number;
      date: string;
      type: string;
      content: string;
      response: string;
    }>;
  };
  propertyAddress?: string;
  onMessagesUpdate?: (messages: Array<{ id: number; date: string; type: string; content: string; response: string; }>) => void;
  onMaintenanceIssuesFound?: (issues: any[]) => void;
}

export default function MessagingModal({ isOpen, onClose, tenant, propertyAddress, onMessagesUpdate, onMaintenanceIssuesFound }: MessagingModalProps) {
  const [isGmailConnected, setIsGmailConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [subject, setSubject] = useState('');
  const [gmailMessages, setGmailMessages] = useState<GmailMessage[]>([]);
  const [activeTab, setActiveTab] = useState<'local' | 'gmail'>('local');
  const [error, setError] = useState<string | null>(null);
  const [gmailAvailable, setGmailAvailable] = useState(true);
  const [replyingTo, setReplyingTo] = useState<GmailMessage | null>(null);
  const [alternativeEmail, setAlternativeEmail] = useState('');

  // Set default email and subject when modal opens
  useEffect(() => {
    if (isOpen && tenant) {
      setSubject(`Re: Property ${tenant.unit} - ${tenant.name}`);
    }
  }, [isOpen, tenant]);

  // Check Gmail connection status
  useEffect(() => {
    const checkGmailStatus = async () => {
      try {
        setIsLoading(true);
        setError(null);
        
        console.log('📧 MessagingModal: Checking Gmail status...');
        const initialized = await gmailService.initialize();
        
        if (initialized) {
          setIsGmailConnected(gmailService.isUserSignedIn());
          setGmailAvailable(true);
          console.log('✅ MessagingModal: Gmail available and initialized');
        } else {
          setGmailAvailable(false);
          setError('Gmail service unavailable. Please check your API configuration.');
          console.warn('⚠️ MessagingModal: Gmail initialization failed');
        }
      } catch (err) {
        console.error('❌ MessagingModal: Error checking Gmail status:', err);
        setGmailAvailable(false);
        setError(err instanceof Error ? err.message : 'Gmail service error');
      } finally {
        setIsLoading(false);
      }
    };

    if (isOpen) {
      checkGmailStatus();
    }
  }, [isOpen]);

  // Reload Gmail messages when alternative email changes
  useEffect(() => {
    if (isGmailConnected) {
      loadGmailMessages();
    }
  }, [alternativeEmail, isGmailConnected]);

  const handleGmailSignIn = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const success = await gmailService.signIn();
      setIsGmailConnected(success);
      if (success) {
        await loadGmailMessages();
      }
    } catch (error: any) {
      console.error('Gmail sign in failed:', error);
      setError(error.message || 'Failed to connect to Gmail. Please try again.');
      
      // Show user-friendly alert for specific errors
      if (error.message?.includes('credentials')) {
        alert('Gmail is not properly configured. Please check the setup guide.');
      } else if (error.message?.includes('cancelled')) {
        // User cancelled - no need to show error
      } else {
        alert('Failed to connect to Gmail. Please check your internet connection and try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleGmailSignOut = async () => {
    try {
      await gmailService.signOut();
      setIsGmailConnected(false);
      setGmailMessages([]);
    } catch (error) {
      console.error('Gmail sign out failed:', error);
    }
  };

  const loadGmailMessages = async () => {
    if (!isGmailConnected) return;

    setIsLoading(true);
    try {
      // Search for messages related to this tenant, including alternative email
      let query = '';
      if (tenant.email) {
        query = `from:${tenant.email} OR to:${tenant.email}`;
        // Include alternative email in search if provided
        if (alternativeEmail.trim()) {
          query += ` OR from:${alternativeEmail.trim()} OR to:${alternativeEmail.trim()}`;
        }
      } else {
        // Fallback to subject-based search
        query = `subject:"${tenant.unit}"`;
        if (alternativeEmail.trim()) {
          query += ` OR from:${alternativeEmail.trim()} OR to:${alternativeEmail.trim()}`;
        }
      }
      
      const messages = await gmailService.getMessages(query);
      // Sort messages by date (newest first)
      const sortedMessages = messages.sort((a, b) => 
        parseInt(b.internalDate) - parseInt(a.internalDate)
      );
      setGmailMessages(sortedMessages);

      // Convert Gmail messages to tenant message format and update parent
      if (onMessagesUpdate && sortedMessages.length > 0) {
        const convertedMessages = sortedMessages.map((msg, idx) => {
          // Extract subject from headers
          const subjectHeader = msg.payload.headers.find(h => h.name.toLowerCase() === 'subject');
          const subject = subjectHeader?.value || 'No subject';
          
          return {
            id: parseInt(msg.id) || idx,
            date: new Date(parseInt(msg.internalDate)).toLocaleDateString(),
            type: 'general',
            content: msg.snippet || subject,
            response: '' // Gmail messages don't have responses yet
          };
        });
        onMessagesUpdate(convertedMessages);
      }

      // 🤖 AUTOMATICALLY ANALYZE MESSAGES FOR MAINTENANCE ISSUES
      if (sortedMessages.length > 0) {
        console.log('🔍 Auto-analyzing messages for maintenance issues...');
        analyzeMessagesForMaintenance(sortedMessages);
      }
    } catch (error) {
      console.error('Failed to load Gmail messages:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // 🤖 AI Analysis: Check for maintenance issues and find providers
  const analyzeMessagesForMaintenance = async (messages: GmailMessage[]) => {
    try {
      const formattedMessages = messages.map((msg, idx) => {
        const subjectHeader = msg.payload.headers.find(h => h.name.toLowerCase() === 'subject');
        const fromHeader = msg.payload.headers.find(h => h.name.toLowerCase() === 'from');
        
        // Extract full email body, not just snippet
        let emailBody = '';
        
        console.log(`📧 Processing message ${idx}:`, {
          hasBody: !!msg.payload.body?.data,
          hasParts: !!msg.payload.parts,
          snippet: msg.snippet?.substring(0, 50)
        });
        
        // Try to get the full text body
        if (msg.payload.body?.data) {
          // Single part message
          try {
            emailBody = atob(msg.payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
            console.log(`✅ Extracted body from single part (${emailBody.length} chars)`);
          } catch (e) {
            console.error('❌ Failed to decode body:', e);
          }
        } else if (msg.payload.parts) {
          // Multi-part message - find text/plain or text/html
          console.log(`📦 Message has ${msg.payload.parts.length} parts`);
          const textPart = msg.payload.parts.find((part: any) => 
            part.mimeType === 'text/plain' || part.mimeType === 'text/html'
          ) as any;
          if (textPart?.body?.data) {
            try {
              emailBody = atob(textPart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
              console.log(`✅ Extracted body from ${textPart?.mimeType || 'unknown'} part (${emailBody.length} chars)`);
            } catch (e) {
              console.error('❌ Failed to decode part:', e);
            }
          } else {
            console.log('⚠️ No text part found in multipart message');
          }
        }
        
        // Fallback to snippet if body extraction fails
        if (!emailBody || emailBody.trim().length === 0) {
          emailBody = msg.snippet || '';
          console.log(`⚠️ Using snippet fallback (${emailBody.length} chars)`);
        }
        
        console.log(`📝 Final email body preview:`, emailBody.substring(0, 100));
        
        return {
          id: idx,
          content: emailBody,
          subject: subjectHeader?.value || 'No subject',
          from: fromHeader?.value || tenant.email || 'tenant',
          date: new Date(parseInt(msg.internalDate)).toISOString()
        };
      });

      const response = await fetch('http://localhost:3001/api/tenant-messages/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: formattedMessages,
          propertyAddress: propertyAddress || 'Potomac MD'
        })
      });

      const result = await response.json();

      if (result.maintenanceIssues > 0) {
        console.log(`⚠️ Found ${result.maintenanceIssues} maintenance issue(s)!`);
        console.log('Issues:', result.issues);
        console.log('Using property address:', propertyAddress || 'Potomac MD');

        // Send detected issues to parent component to populate AI Provider Match
        // This will automatically trigger the provider search without user interaction
        if (onMaintenanceIssuesFound) {
          onMaintenanceIssuesFound(result.issues);
        }

        // Alert removed - AI now automatically searches for providers in the background
      } else {
        console.log('✅ No maintenance issues detected in messages');
      }
    } catch (error) {
      console.error('❌ Failed to analyze messages:', error);
    }
  };

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !subject.trim()) {
      setError('Please enter both a subject and message.');
      return;
    }

    // Use alternative email if provided, otherwise fall back to tenant email
    const targetEmail = alternativeEmail.trim() || tenant.email || 'tenant@example.com';

    setIsLoading(true);
    setError(null);
    
    try {
      if (isGmailConnected) {
        // Send via Gmail with improved error handling
        const result = await gmailService.sendMessage(targetEmail, subject, newMessage);
        
        if (result.success) {
          setNewMessage('');
          setSubject(`Re: Property ${tenant.unit} - ${tenant.name}`); // Reset to default
          await loadGmailMessages(); // Refresh messages
          
          // Show success message with message ID
          const successMsg = result.messageId ? 
            `Message sent successfully via Gmail! (ID: ${result.messageId.substring(0, 8)}...)` :
            'Message sent successfully via Gmail!';
          alert(successMsg);
        } else {
          const errorMsg = result.error || 'Unknown error occurred';
          setError(`Failed to send via Gmail: ${errorMsg}`);
          
          // Show user-friendly error
          if (errorMsg.includes('quota') || errorMsg.includes('limit')) {
            alert('Gmail sending limit reached. Please try again later.');
          } else if (errorMsg.includes('permission') || errorMsg.includes('scope')) {
            alert('Gmail permissions issue. Please sign out and sign in again.');
          } else {
            alert(`Failed to send message: ${errorMsg}`);
          }
        }
      } else {
        // Simulate local message sending
        console.log('Sending local message:', { to: targetEmail, subject, message: newMessage });
        setNewMessage('');
        setSubject(`Re: Property ${tenant.unit} - ${tenant.name}`); // Reset to default
        alert('Message sent locally (Gmail not connected)');
      }
    } catch (error: any) {
      console.error('Failed to send message:', error);
      const errorMsg = error.message || 'Unknown error occurred';
      setError(`Failed to send message: ${errorMsg}`);
      
      // Show user-friendly error based on error type
      if (errorMsg.includes('not signed in')) {
        alert('Please sign in to Gmail first.');
        setIsGmailConnected(false);
      } else if (errorMsg.includes('network') || errorMsg.includes('fetch')) {
        alert('Network error. Please check your connection and try again.');
      } else {
        alert(`Failed to send message: ${errorMsg}`);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleReply = (message: GmailMessage) => {
    const originalSubject = gmailService.getMessageHeader(message, 'subject') || '';
    const replySubject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;
    
    setSubject(replySubject);
    setReplyingTo(message);
    setNewMessage(''); // Clear any existing message
    
    // Scroll to message composer
    const composer = document.querySelector('[data-composer]');
    if (composer) {
      composer.scrollIntoView({ behavior: 'smooth' });
    }
  };

  const handleSendReply = async () => {
    if (!replyingTo || !newMessage.trim()) {
      setError('Please enter a message to send.');
      return;
    }

    setIsLoading(true);
    setError(null);
    
    try {
      const result = await gmailService.sendReply(replyingTo, newMessage);
      
      if (result.success) {
        setNewMessage('');
        setReplyingTo(null);
        setSubject(`Re: Property ${tenant.unit} - ${tenant.name}`); // Reset to default
        await loadGmailMessages(); // Refresh messages
        
        const successMsg = result.messageId ? 
          `Reply sent successfully! (ID: ${result.messageId.substring(0, 8)}...)` :
          'Reply sent successfully!';
        alert(successMsg);
      } else {
        const errorMsg = result.error || 'Unknown error occurred';
        setError(`Failed to send reply: ${errorMsg}`);
        alert(`Failed to send reply: ${errorMsg}`);
      }
    } catch (error: any) {
      console.error('Failed to send reply:', error);
      const errorMsg = error.message || 'Unknown error occurred';
      setError(`Failed to send reply: ${errorMsg}`);
      alert(`Failed to send reply: ${errorMsg}`);
    } finally {
      setIsLoading(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(parseInt(dateString));
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const isMessageFromTenant = (message: GmailMessage) => {
    const fromEmail = gmailService.getMessageHeader(message, 'from') || '';
    const tenantEmails = [tenant.email, alternativeEmail.trim()].filter(Boolean) as string[];
    return tenantEmails.some(email => fromEmail.toLowerCase().includes(email.toLowerCase()));
  };

  const getMessagePreview = (message: GmailMessage) => {
    const body = gmailService.decodeMessageBody(message);
    return body.substring(0, 200) + (body.length > 200 ? '...' : '');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[10000] bg-gray-900/50 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-800">
              Messages - {tenant.name} (Unit {tenant.unit})
            </h2>
            <p className="text-sm text-gray-500 mt-1">
              {tenant.email || 'No email on file'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* Gmail Connection Status */}
            <div className="flex items-center gap-2">
              {!gmailAvailable ? (
                <>
                  <div className="w-2 h-2 bg-red-500 rounded-full"></div>
                  <span className="text-sm text-red-600">Gmail Not Configured</span>
                  <span className="text-xs text-gray-500">Check setup guide</span>
                </>
              ) : isGmailConnected ? (
                <>
                  <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                  <span className="text-sm text-green-600">Gmail Connected</span>
                  <button
                    onClick={handleGmailSignOut}
                    className="text-xs text-gray-500 hover:text-gray-700 underline"
                  >
                    Disconnect
                  </button>
                </>
              ) : (
                <>
                  <div className="w-2 h-2 bg-gray-400 rounded-full"></div>
                  <span className="text-sm text-gray-500">Gmail Disconnected</span>
                  <button
                    onClick={handleGmailSignIn}
                    disabled={isLoading || !gmailAvailable}
                    className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700 disabled:opacity-50"
                  >
                    {isLoading ? 'Connecting...' : 'Connect Gmail'}
                  </button>
                </>
              )}
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 p-1"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="px-6 py-3 bg-red-50 border-b border-red-200">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm text-red-700">{error}</span>
              <button
                onClick={() => setError(null)}
                className="ml-auto text-red-500 hover:text-red-700"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* Alternative Email Section */}
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Alternative Email Address
              </label>
              <input
                type="email"
                value={alternativeEmail}
                onChange={(e) => setAlternativeEmail(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                placeholder="Enter alternative email for this tenant..."
              />
            </div>
            <div className="flex items-end">
              <button
                onClick={() => setAlternativeEmail('')}
                className="px-3 py-2 text-sm text-gray-500 hover:text-gray-700 border border-gray-300 rounded-md hover:bg-gray-100"
              >
                Clear
              </button>
            </div>
          </div>
          {alternativeEmail && (
            <div className="mt-2 text-xs text-blue-600">
              📧 Messages will be sent to: <span className="font-medium">{alternativeEmail}</span>
            </div>
          )}
        </div>

        {/* AI Summary */}
        {(tenant as any).aiSummary && (
          <div className="px-6 py-4 bg-blue-50 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-blue-800 mb-2">AI Correspondence Summary</h3>
            <p className="text-sm text-blue-700">{(tenant as any).aiSummary}</p>
          </div>
        )}

        {/* Tabs */}
        <div className="px-6 border-b border-gray-200">
          <div className="flex space-x-8">
            <button
              onClick={() => setActiveTab('local')}
              className={`py-4 text-sm font-medium border-b-2 ${
                activeTab === 'local'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Local Messages ({tenant.messages.length})
            </button>
            <button
              onClick={() => setActiveTab('gmail')}
              className={`py-4 text-sm font-medium border-b-2 ${
                activeTab === 'gmail'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              Gmail Messages ({gmailMessages.length})
              {!isGmailConnected && (
                <span className="ml-1 text-xs text-gray-400">(Connect Gmail)</span>
              )}
            </button>
            {isGmailConnected && activeTab === 'gmail' && (
              <button
                onClick={loadGmailMessages}
                disabled={isLoading}
                className="py-2 px-3 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition-colors disabled:opacity-50"
                title="Refresh Gmail messages"
              >
                {isLoading ? '⟳' : '↻'} Refresh
              </button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex flex-col" style={{ height: 'calc(90vh - 200px)' }}>
          {/* Messages List */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {activeTab === 'local' ? (
              // Local Messages
              tenant.messages.length > 0 ? (
                tenant.messages.map(message => (
                  <div key={message.id} className="bg-gray-50 rounded-lg p-4">
                    <div className="flex justify-between items-start mb-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        message.type === 'maintenance' ? 'bg-orange-100 text-orange-700' :
                        message.type === 'lease' ? 'bg-purple-100 text-purple-700' :
                        'bg-gray-100 text-gray-700'
                      }`}>
                        {message.type.charAt(0).toUpperCase() + message.type.slice(1)}
                      </span>
                      <span className="text-xs text-gray-500">{message.date}</span>
                    </div>
                    <div className="space-y-3">
                      <div>
                        <div className="text-xs text-gray-500 mb-1">From Tenant:</div>
                        <p className="text-sm text-gray-800">{message.content}</p>
                      </div>
                      <div>
                        <div className="text-xs text-gray-500 mb-1">Your Response:</div>
                        <p className="text-sm text-gray-600">{message.response}</p>
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-center text-gray-500 py-8">
                  No local messages yet
                </div>
              )
            ) : (
              // Gmail Messages
              isGmailConnected ? (
                isLoading ? (
                  <div className="text-center text-gray-500 py-8">
                    Loading Gmail messages...
                  </div>
                ) : gmailMessages.length > 0 ? (
                  gmailMessages.map(message => {
                    const isTenantMessage = isMessageFromTenant(message);
                    return (
                    <div key={message.id} className={`rounded-lg p-4 ${isTenantMessage ? 'bg-blue-50 border-l-4 border-blue-400' : 'bg-gray-50'}`}>
                      <div className="flex justify-between items-start mb-2">
                        <div className="font-medium text-sm text-gray-800">
                          From: {gmailService.getMessageHeader(message, 'from') || 'Unknown Sender'}
                          {isTenantMessage && (
                            <span className="ml-2 px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded-full">
                              📩 Tenant Response
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">
                            {formatDate(message.internalDate)}
                          </span>
                          <button
                            onClick={() => handleReply(message)}
                            className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
                          >
                            Reply
                          </button>
                        </div>
                      </div>
                      <div className="text-xs text-gray-600 mb-2">
                        To: {gmailService.getMessageHeader(message, 'to') || 'Unknown Recipient'}
                      </div>
                      <div className="text-sm font-medium text-gray-700 mb-2">
                        {gmailService.getMessageHeader(message, 'subject') || 'No Subject'}
                      </div>
                      <p className="text-sm text-gray-600">
                        {getMessagePreview(message)}
                      </p>
                    </div>
                    );
                  })
                ) : (
                  <div className="text-center text-gray-500 py-8">
                    No Gmail messages found for this tenant
                  </div>
                )
              ) : (
                <div className="text-center text-gray-500 py-8">
                  Connect Gmail to view email messages
                </div>
              )
            )}
          </div>

          {/* Message Composer */}
          <div className="border-t border-gray-200 p-6 bg-gray-50" data-composer>
            {replyingTo && (
              <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-md">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-blue-800">
                    <span className="font-medium">Replying to:</span> {gmailService.getMessageHeader(replyingTo, 'subject') || 'No Subject'}
                  </div>
                  <button
                    onClick={() => {
                      setReplyingTo(null);
                      setSubject(`Re: Property ${tenant.unit} - ${tenant.name}`);
                      setNewMessage('');
                    }}
                    className="text-blue-600 hover:text-blue-800"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Subject {replyingTo && <span className="text-xs text-gray-500">(replying to message)</span>}
                </label>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  readOnly={!!replyingTo}
                  className={`w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    replyingTo ? 'bg-gray-100 cursor-not-allowed' : ''
                  }`}
                  placeholder="Enter subject..."
                />
              </div>

              {/* Email selection preview */}
              <div className="p-3 bg-gray-50 rounded-md border">
                <div className="text-sm text-gray-600">
                  <span className="font-medium">Sending to:</span>{' '}
                  <span className="text-blue-600">
                    {alternativeEmail.trim() || tenant.email || 'tenant@example.com'}
                  </span>
                  {alternativeEmail.trim() && (
                    <span className="text-gray-500 ml-2">(alternative email)</span>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Message</label>
                <textarea
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Type your message..."
                />
              </div>
              <div className="flex justify-between items-center">
                <div className="text-xs text-gray-500">
                  {isGmailConnected ? 
                    `Will send via Gmail to: ${tenant.email || 'tenant@example.com'}` : 
                    'Local message (Connect Gmail for email delivery)'
                  }
                </div>
                <button
                  onClick={replyingTo ? handleSendReply : handleSendMessage}
                  disabled={isLoading || !newMessage.trim() || (!replyingTo && !subject.trim())}
                  className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {isLoading && (
                    <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                  )}
                  {replyingTo ? 'Send Reply' : 'Send Message'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
