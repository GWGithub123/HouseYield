/**
 * Tenant Interview System - AI Phone Interview for Tenant Screening
 * 
 * This module provides automated AI-powered phone interviews for tenant applicants.
 * Features:
 *   1. Schedule interviews via email with calendar booking links
 *   2. Automated AI phone calls at scheduled time using OpenAI Realtime
 *   3. Intelligent screening questions tailored to property requirements
 *   4. AI-powered response analysis and tenant rating
 *   5. Comprehensive interview summaries for property managers
 * 
 * Integration:
 *   - Uses Twilio for phone calls
 *   - OpenAI Realtime API for natural conversation
 *   - Nodemailer for scheduling emails
 *   - Firestore for storing interview data
 */

import twilio from 'twilio';
import { WebSocketServer, WebSocket } from 'ws';
import { promisify } from 'util';
import { exec, spawn } from 'child_process';
import crypto from 'crypto';
import { initializeFirebaseAdmin, getFirestore } from './firebase-admin.js';

const execAsync = promisify(exec);

// Initialize Firebase
initializeFirebaseAdmin();

// ===================================================================
// CONFIGURATION
// ===================================================================

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_API_KEY_SID = process.env.TWILIO_API_KEY_SID;
const TWILIO_API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;

// Firestore collection name
const INTERVIEWS_COLLECTION = 'tenant_interviews';

// Sample rates
const OPENAI_SAMPLE_RATE = 24000;
const TWILIO_SAMPLE_RATE = 8000;

// Interview storage (in-memory cache, synced with Firestore)
const scheduledInterviews = new Map();
const completedInterviews = new Map();
const interviewTranscripts = new Map();

// Active interview sessions
const activeInterviewSockets = new Set();
const interviewContextStore = new Map();

// ===================================================================
// FIRESTORE PERSISTENCE FUNCTIONS
// ===================================================================

/**
 * Save interview to Firestore
 */
async function saveInterviewToFirestore(interview) {
  try {
    const db = getFirestore();
    const docRef = db.collection(INTERVIEWS_COLLECTION).doc(interview.id);
    
    // Prepare interview data for Firestore (remove non-serializable data)
    const firestoreData = {
      ...interview,
      // Ensure dates are properly formatted
      createdAt: interview.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Remove any circular references or non-serializable data
      questions: interview.questions?.map(q => ({
        id: q.id,
        category: q.category,
        question: q.question,
        followUp: q.followUp || null,
        scoringCriteria: q.scoringCriteria || []
      })) || []
    };
    
    await docRef.set(firestoreData, { merge: true });
    console.log(`[Interview] 💾 Saved to Firestore: ${interview.id}`);
    return true;
  } catch (error) {
    console.error(`[Interview] ❌ Firestore save failed:`, error.message);
    return false;
  }
}

/**
 * Load interview from Firestore
 */
async function loadInterviewFromFirestore(interviewId) {
  try {
    const db = getFirestore();
    const docRef = db.collection(INTERVIEWS_COLLECTION).doc(interviewId);
    const doc = await docRef.get();
    
    if (doc.exists) {
      return doc.data();
    }
    return null;
  } catch (error) {
    console.error(`[Interview] ❌ Firestore load failed:`, error.message);
    return null;
  }
}

/**
 * Load all interviews for an owner from Firestore
 */
async function loadOwnerInterviewsFromFirestore(ownerId) {
  try {
    const db = getFirestore();
    const snapshot = await db.collection(INTERVIEWS_COLLECTION)
      .where('ownerId', '==', ownerId)
      .orderBy('createdAt', 'desc')
      .get();
    
    const interviews = [];
    snapshot.forEach(doc => {
      interviews.push(doc.data());
    });
    
    console.log(`[Interview] 📂 Loaded ${interviews.length} interviews for owner ${ownerId}`);
    return interviews;
  } catch (error) {
    console.error(`[Interview] ❌ Firestore query failed:`, error.message);
    return [];
  }
}

/**
 * Load all interviews for a property from Firestore
 */
async function loadPropertyInterviewsFromFirestore(propertyAddress) {
  try {
    const db = getFirestore();
    const snapshot = await db.collection(INTERVIEWS_COLLECTION)
      .where('propertyAddress', '==', propertyAddress)
      .orderBy('createdAt', 'desc')
      .get();
    
    const interviews = [];
    snapshot.forEach(doc => {
      interviews.push(doc.data());
    });
    
    return interviews;
  } catch (error) {
    console.error(`[Interview] ❌ Firestore query failed:`, error.message);
    return [];
  }
}

/**
 * Load interviews from Firestore on startup
 */
async function loadInterviewsFromFirestore() {
  try {
    const db = getFirestore();
    const snapshot = await db.collection(INTERVIEWS_COLLECTION)
      .orderBy('createdAt', 'desc')
      .limit(100) // Load last 100 interviews
      .get();
    
    let scheduledCount = 0;
    let completedCount = 0;
    
    snapshot.forEach(doc => {
      const interview = doc.data();
      if (interview.status === 'completed' || interview.status === 'analyzing') {
        completedInterviews.set(interview.id, interview);
        completedCount++;
      } else {
        scheduledInterviews.set(interview.id, interview);
        scheduledCount++;
      }
    });
    
    console.log(`[Interview] 📂 Loaded from Firestore: ${scheduledCount} scheduled, ${completedCount} completed`);
  } catch (error) {
    console.error(`[Interview] ❌ Firestore startup load failed:`, error.message);
  }
}

// Load interviews on module initialization
loadInterviewsFromFirestore();

// ===================================================================
// TWILIO CLIENT INITIALIZATION
// ===================================================================

// Initialize Twilio client
let twilioClient = null;
if (TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET && TWILIO_ACCOUNT_SID) {
  twilioClient = twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, { 
    accountSid: TWILIO_ACCOUNT_SID 
  });
  console.log('✅ [Interview] Twilio client initialized');
} else if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  console.log('✅ [Interview] Twilio client initialized with Auth Token');
} else {
  console.warn('⚠️  [Interview] Twilio not configured - interviews disabled');
}

// ===================================================================
// INTERVIEW QUESTIONS CONFIGURATION
// ===================================================================

const DEFAULT_INTERVIEW_QUESTIONS = [
  {
    id: 'employment',
    category: 'Employment & Income',
    question: "Can you tell me a bit about your current employment situation? What do you do for work and how long have you been at your current job?",
    followUp: "That's great. And is this a full-time position?",
    scoringCriteria: ['stable employment', 'duration > 1 year', 'full-time', 'verifiable income']
  },
  {
    id: 'rental_history',
    category: 'Rental History',
    question: "Could you walk me through your rental history? How long have you been at your current place and why are you looking to move?",
    followUp: "Would your current landlord be willing to provide a reference?",
    scoringCriteria: ['positive landlord relationship', 'reasonable move reason', 'no evictions', 'stable history']
  },
  {
    id: 'occupants',
    category: 'Household',
    question: "Who will be living in the unit with you? Any roommates, family members, or pets?",
    followUp: null,
    scoringCriteria: ['clear answer', 'within occupancy limits', 'pet policy compliance']
  },
  {
    id: 'move_timeline',
    category: 'Move-in Timeline',
    question: "When are you looking to move in? Is there any flexibility with that date?",
    followUp: null,
    scoringCriteria: ['reasonable timeline', 'flexibility shown']
  },
  {
    id: 'lease_term',
    category: 'Lease Preference',
    question: "Are you looking for a long-term rental? What lease length works best for you?",
    followUp: null,
    scoringCriteria: ['long-term intent', 'stability indicators']
  },
  {
    id: 'income_verification',
    category: 'Income',
    question: "Just to confirm, would you be comfortable providing proof of income? Pay stubs or bank statements work great for that.",
    followUp: "Perfect. And would your income meet the requirement of roughly three times the monthly rent?",
    scoringCriteria: ['willingness to verify', 'income ratio confidence']
  },
  {
    id: 'background_consent',
    category: 'Background Check',
    question: "As part of our standard process, we run a background and credit check. Are you comfortable with that?",
    followUp: "Is there anything that might show up that you'd like to explain upfront?",
    scoringCriteria: ['consent given', 'transparency', 'proactive disclosure']
  },
  {
    id: 'questions',
    category: 'Applicant Questions',
    question: "Do you have any questions about the property or the application process?",
    followUp: null,
    scoringCriteria: ['engagement level', 'thoughtful questions']
  }
];

// ===================================================================
// INTERVIEW SCHEDULING
// ===================================================================

/**
 * Schedule a tenant interview
 * @param {Object} options
 * @param {string} options.applicantId - Applicant ID
 * @param {string} options.applicantName - Applicant's name
 * @param {string} options.applicantEmail - Applicant's email
 * @param {string} options.applicantPhone - Applicant's phone number
 * @param {string} options.propertyAddress - Property address
 * @param {string} options.ownerId - Property owner ID
 * @param {number} options.monthlyRent - Monthly rent amount
 * @param {Date} options.scheduledTime - Scheduled interview time
 * @param {Array} options.customQuestions - Optional custom questions
 * @returns {Object} Interview scheduling result
 */
export async function scheduleInterview({
  applicantId,
  applicantName,
  applicantEmail,
  applicantPhone,
  propertyAddress,
  ownerId,
  monthlyRent,
  scheduledTime,
  customQuestions = []
}) {
  const interviewId = crypto.randomBytes(16).toString('hex');
  const bookingToken = crypto.randomBytes(32).toString('hex');
  
  const interview = {
    id: interviewId,
    bookingToken,
    applicantId,
    applicantName,
    applicantEmail,
    applicantPhone,
    propertyAddress,
    ownerId,
    monthlyRent,
    scheduledTime: scheduledTime ? new Date(scheduledTime).toISOString() : null,
    status: scheduledTime ? 'scheduled' : 'pending_booking',
    questions: customQuestions.length > 0 ? customQuestions : DEFAULT_INTERVIEW_QUESTIONS,
    createdAt: new Date().toISOString(),
    callAttempts: 0,
    transcript: [],
    responses: {},
    aiSummary: null,
    rating: null
  };
  
  scheduledInterviews.set(interviewId, interview);
  
  // Save to Firestore
  await saveInterviewToFirestore(interview);
  
  console.log(`[Interview] ✅ Scheduled interview ${interviewId} for ${applicantName}`);
  console.log(`[Interview]    Property: ${propertyAddress}`);
  console.log(`[Interview]    Status: ${interview.status}`);
  if (scheduledTime) {
    console.log(`[Interview]    Time: ${new Date(scheduledTime).toLocaleString()}`);
  }
  
  return {
    ok: true,
    interviewId,
    bookingToken,
    interview
  };
}

/**
 * Get available interview time slots
 * @param {Date} startDate - Start date for availability
 * @param {number} days - Number of days to show
 * @returns {Array} Available time slots
 */
export function getAvailableSlots(startDate = new Date(), days = 7) {
  const slots = [];
  const now = new Date();
  
  for (let d = 0; d < days; d++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + d);
    
    // Skip weekends
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    
    // Available slots: 9 AM - 6 PM, 30-minute intervals
    for (let hour = 9; hour < 18; hour++) {
      for (let min = 0; min < 60; min += 30) {
        const slotTime = new Date(date);
        slotTime.setHours(hour, min, 0, 0);
        
        // Skip past times
        if (slotTime <= now) continue;
        
        // Check if slot is already booked
        const isBooked = Array.from(scheduledInterviews.values()).some(interview => {
          if (!interview.scheduledTime) return false;
          const interviewTime = new Date(interview.scheduledTime);
          return Math.abs(interviewTime.getTime() - slotTime.getTime()) < 30 * 60 * 1000;
        });
        
        if (!isBooked) {
          slots.push({
            time: slotTime.toISOString(),
            display: slotTime.toLocaleString('en-US', {
              weekday: 'short',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true
            })
          });
        }
      }
    }
  }
  
  return slots;
}

/**
 * Book an interview slot
 * @param {string} bookingToken - Booking token
 * @param {string} selectedTime - Selected time slot ISO string
 * @returns {Object} Booking result
 */
export async function bookInterviewSlot(bookingToken, selectedTime) {
  // Find interview by booking token
  const interview = Array.from(scheduledInterviews.values()).find(
    i => i.bookingToken === bookingToken
  );
  
  if (!interview) {
    return { ok: false, error: 'Invalid booking token' };
  }
  
  if (interview.status !== 'pending_booking') {
    return { ok: false, error: 'Interview already scheduled' };
  }
  
  const scheduledTime = new Date(selectedTime);
  if (scheduledTime <= new Date()) {
    return { ok: false, error: 'Cannot book a time in the past' };
  }
  
  // Update interview
  interview.scheduledTime = scheduledTime.toISOString();
  interview.status = 'scheduled';
  interview.bookedAt = new Date().toISOString();
  
  // Save to Firestore
  await saveInterviewToFirestore(interview);
  
  console.log(`[Interview] ✅ Interview ${interview.id} booked for ${scheduledTime.toLocaleString()}`);
  
  // Schedule the actual call
  scheduleInterviewCall(interview);
  
  return {
    ok: true,
    interview: {
      id: interview.id,
      scheduledTime: interview.scheduledTime,
      applicantName: interview.applicantName,
      propertyAddress: interview.propertyAddress
    }
  };
}

/**
 * Book and start an interview immediately
 * @param {string} bookingToken - Booking token
 * @param {string|null} publicUrl - Public URL for Twilio webhooks
 * @returns {Object} Booking + call result
 */
export async function bookInterviewNow(bookingToken, publicUrl = null) {
  const interview = Array.from(scheduledInterviews.values()).find(
    i => i.bookingToken === bookingToken
  );

  if (!interview) {
    return { ok: false, error: 'Invalid booking token' };
  }

  if (interview.status !== 'pending_booking') {
    return { ok: false, error: 'Interview already scheduled' };
  }

  interview.scheduledTime = new Date().toISOString();
  interview.status = 'scheduled';
  interview.bookedAt = new Date().toISOString();

  await saveInterviewToFirestore(interview);

  const callResult = await initiateInterviewCall(interview.id, publicUrl);
  return {
    ok: !!callResult.ok,
    interview: {
      id: interview.id,
      scheduledTime: interview.scheduledTime,
      applicantName: interview.applicantName,
      propertyAddress: interview.propertyAddress
    },
    call: callResult
  };
}

/**
 * Schedule the interview call to happen at the right time
 */
function scheduleInterviewCall(interview) {
  const now = new Date();
  const callTime = new Date(interview.scheduledTime);
  const delay = callTime.getTime() - now.getTime();
  
  if (delay <= 0) {
    console.log(`[Interview] Call time already passed, initiating immediately`);
    initiateInterviewCall(interview.id);
    return;
  }
  
  console.log(`[Interview] Scheduling call for ${interview.applicantName} in ${Math.round(delay / 60000)} minutes`);
  
  setTimeout(() => {
    initiateInterviewCall(interview.id);
  }, delay);
}

// ===================================================================
// AI PHONE INTERVIEW EXECUTION
// ===================================================================

/**
 * Initiate the AI interview call
 * @param {string} interviewId - Interview ID
 * @returns {Object} Call result
 */
export async function initiateInterviewCall(interviewId, publicUrl = null) {
  const interview = scheduledInterviews.get(interviewId);
  
  if (!interview) {
    return { ok: false, error: 'Interview not found' };
  }
  
  if (!twilioClient) {
    return { ok: false, error: 'Twilio not configured' };
  }
  
  if (!interview.applicantPhone) {
    return { ok: false, error: 'No phone number for applicant' };
  }
  
  interview.callAttempts++;
  interview.status = 'calling';
  interview.lastCallAttempt = new Date().toISOString();
  
  console.log(`[Interview] 📞 Initiating call for interview ${interviewId}`);
  console.log(`[Interview]    To: ${interview.applicantPhone}`);
  console.log(`[Interview]    Attempt: ${interview.callAttempts}`);
  
  try {
    // Use provided publicUrl, or fall back to env variables
    const baseUrl = publicUrl || process.env.PUBLIC_URL || process.env.NGROK_URL;
    if (!baseUrl) {
      throw new Error('PUBLIC_URL not configured for webhooks. Please set PUBLIC_URL or NGROK_URL environment variable.');
    }
    
    console.log(`[Interview]    Using publicUrl: ${baseUrl}`);
    
    // Store context for the call
    interviewContextStore.set(interviewId, interview);
    
    const twimlUrl = `${baseUrl}/twiml/tenant-interview?interviewId=${interviewId}`;
    const statusUrl = `${baseUrl}/twilio/interview-status`;
    
    const call = await twilioClient.calls.create({
      to: interview.applicantPhone,
      from: TWILIO_FROM_NUMBER,
      url: twimlUrl,
      statusCallback: statusUrl,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      timeout: 60,
      machineDetection: 'Enable',
      machineDetectionTimeout: 5
    });
    
    interview.callSid = call.sid;
    interview.status = 'in_progress';
    interview.callStartedAt = new Date().toISOString();
    
    // Save call initiation to Firestore
    await saveInterviewToFirestore(interview);
    
    console.log(`[Interview] ✅ Call initiated: ${call.sid}`);
    
    return {
      ok: true,
      callSid: call.sid,
      interviewId
    };
  } catch (error) {
    console.error(`[Interview] ❌ Call failed:`, error.message);
    interview.status = 'call_failed';
    interview.lastError = error.message;
    interview.callFailedAt = new Date().toISOString();
    
    // Save failure to Firestore
    saveInterviewToFirestore(interview);
    
    return {
      ok: false,
      error: error.message
    };
  }
}

/**
 * Generate TwiML for interview call
 */
export function generateInterviewTwiML(interviewId, publicUrl) {
  const interview = interviewContextStore.get(interviewId) || scheduledInterviews.get(interviewId);
  
  if (!interview) {
    return `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say>Sorry, we couldn't find your interview. Please contact support.</Say>
        <Hangup />
      </Response>`;
  }
  
  // Connect to OpenAI Realtime via WebSocket
  const wsUrl = publicUrl.replace(/^https?/, 'wss') + '/interview-media';
  
  return `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="${wsUrl}">
          <Parameter name="interviewId" value="${interviewId}" />
          <Parameter name="applicantName" value="${interview.applicantName}" />
        </Stream>
      </Connect>
    </Response>`;
}

/**
 * Get AI interview instructions based on interview context
 */
function getInterviewInstructions(interview) {
  const questions = interview.questions || DEFAULT_INTERVIEW_QUESTIONS;
  const questionList = questions.map((q, i) => `${i + 1}. ${q.question}`).join('\n');
  
  return `You are Alex, a friendly property manager from HouseYield conducting a phone interview with a rental applicant. Your goal is to have a natural, conversational interview while gathering important information.

APPLICANT CONTEXT:
- Name: ${interview.applicantName}
- Property: ${interview.propertyAddress}
- Monthly Rent: $${interview.monthlyRent || 'TBD'}

INTERVIEW STRUCTURE:
1. Start with a warm greeting and introduce yourself
2. Ask these questions naturally (don't read them like a script):
${questionList}

CONVERSATION GUIDELINES:
- Be warm, professional, and conversational
- Use their name occasionally but not excessively
- Listen actively and ask natural follow-up questions
- Use contractions and casual language (I'm, that's, you're)
- React genuinely: "That's great!", "I understand", "Gotcha"
- If they seem nervous, reassure them this is informal
- Keep responses concise - don't monologue
- Take note of any red flags or positive indicators

SCORING MENTAL NOTES:
As you interview, mentally note:
- Employment stability and income confidence
- Rental history and landlord relationships
- Clarity and honesty in answers
- Communication style and professionalism
- Any concerning responses or evasiveness

ENDING THE CALL:
- Thank them for their time
- Let them know they'll hear back within 2-3 business days
- Wish them a great day
- Say goodbye naturally

Remember: You're not interrogating them. You're having a conversation to get to know them as a potential tenant. Be personable!`;
}

// ===================================================================
// INTERVIEW ANALYSIS & RATING
// ===================================================================

/**
 * Analyze interview transcript and generate rating
 * @param {string} interviewId - Interview ID
 * @returns {Object} Analysis result
 */
export async function analyzeInterview(interviewId) {
  const interview = scheduledInterviews.get(interviewId) || completedInterviews.get(interviewId);
  
  if (!interview) {
    return { ok: false, error: 'Interview not found' };
  }
  
  if (!interview.transcript || interview.transcript.length === 0) {
    return { ok: false, error: 'No transcript available' };
  }
  
  console.log(`[Interview] 🔍 Analyzing interview ${interviewId}`);
  
  try {
    const transcriptText = interview.transcript.map(t => 
      `${t.speaker}: ${t.text}`
    ).join('\n');
    
    const analysisPrompt = `You are an expert property manager analyzing a tenant interview transcript. Evaluate the applicant based on the conversation.

INTERVIEW TRANSCRIPT:
${transcriptText}

PROPERTY CONTEXT:
- Address: ${interview.propertyAddress}
- Monthly Rent: $${interview.monthlyRent || 'Unknown'}
- Applicant: ${interview.applicantName}

Provide a comprehensive analysis in JSON format:
{
  "summary": "2-3 paragraph summary of the interview and key takeaways",
  "employmentAssessment": {
    "score": 1-10,
    "notes": "Assessment of employment stability and income"
  },
  "rentalHistoryAssessment": {
    "score": 1-10,
    "notes": "Assessment of rental history and landlord relationships"
  },
  "communicationAssessment": {
    "score": 1-10,
    "notes": "How well they communicated, honesty indicators"
  },
  "redFlags": ["List any concerning responses or behaviors"],
  "positiveIndicators": ["List positive signs about this applicant"],
  "overallScore": 1-100,
  "recommendation": "APPROVE" | "CONDITIONAL" | "DECLINE",
  "recommendationReason": "Brief explanation of recommendation",
  "suggestedFollowUp": ["Any follow-up actions recommended"]
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are an expert property manager. Respond only with valid JSON.' },
          { role: 'user', content: analysisPrompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const analysis = JSON.parse(data.choices[0].message.content);
    
    // Update interview with analysis
    interview.aiSummary = analysis.summary;
    interview.rating = {
      overall: analysis.overallScore,
      employment: analysis.employmentAssessment,
      rentalHistory: analysis.rentalHistoryAssessment,
      communication: analysis.communicationAssessment
    };
    interview.recommendation = analysis.recommendation;
    interview.recommendationReason = analysis.recommendationReason;
    interview.redFlags = analysis.redFlags;
    interview.positiveIndicators = analysis.positiveIndicators;
    interview.suggestedFollowUp = analysis.suggestedFollowUp;
    interview.analyzedAt = new Date().toISOString();
    interview.status = 'completed';
    
    // Move to completed interviews
    completedInterviews.set(interviewId, interview);
    scheduledInterviews.delete(interviewId);
    
    // Save to Firestore with complete analysis
    await saveInterviewToFirestore(interview);
    
    console.log(`[Interview] ✅ Analysis complete for ${interviewId}`);
    console.log(`[Interview]    Score: ${analysis.overallScore}/100`);
    console.log(`[Interview]    Recommendation: ${analysis.recommendation}`);
    
    return {
      ok: true,
      analysis
    };
  } catch (error) {
    console.error(`[Interview] ❌ Analysis failed:`, error.message);
    return {
      ok: false,
      error: error.message
    };
  }
}

// ===================================================================
// WEBSOCKET HANDLER FOR INTERVIEW CALLS
// ===================================================================

/**
 * μ-law encoding constants
 */
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function linearToMulaw(sample) {
  let sign = (sample < 0) ? 0x80 : 0;
  if (sign) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; mask !== 0x40; mask >>= 1) {
    if (sample >= mask) break;
    exponent--;
  }
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  let mulaw = ~(sign | (exponent << 4) | mantissa);
  return mulaw & 0xFF;
}

function mulawToLinear(mulaw) {
  mulaw = ~mulaw;
  let sign = (mulaw & 0x80) !== 0;
  let exponent = (mulaw >> 4) & 0x07;
  let mantissa = mulaw & 0x0F;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

function mulawToPcm16(mulawBuffer) {
  const pcm16Buffer = Buffer.alloc(mulawBuffer.length * 2);
  for (let i = 0; i < mulawBuffer.length; i++) {
    const linear = mulawToLinear(mulawBuffer[i]);
    pcm16Buffer.writeInt16LE(linear, i * 2);
  }
  return pcm16Buffer;
}

function pcm16ToMulaw(pcm16Buffer) {
  const mulawBuffer = Buffer.alloc(pcm16Buffer.length / 2);
  for (let i = 0; i < pcm16Buffer.length; i += 2) {
    const sample = pcm16Buffer.readInt16LE(i);
    mulawBuffer[i / 2] = linearToMulaw(sample);
  }
  return mulawBuffer;
}

function upsample8kTo24k(pcm16_8k) {
  const samplesIn = pcm16_8k.length / 2;
  const samplesOut = samplesIn * 3;
  const pcm16_24k = Buffer.alloc(samplesOut * 2);
  
  for (let i = 0; i < samplesIn; i++) {
    const sm1 = i > 0 ? pcm16_8k.readInt16LE((i - 1) * 2) : pcm16_8k.readInt16LE(i * 2);
    const s0 = pcm16_8k.readInt16LE(i * 2);
    const s1 = i < samplesIn - 1 ? pcm16_8k.readInt16LE((i + 1) * 2) : s0;
    const s2 = i < samplesIn - 2 ? pcm16_8k.readInt16LE((i + 2) * 2) : s1;
    
    pcm16_24k.writeInt16LE(s0, i * 6);
    
    for (let j = 1; j < 3; j++) {
      const t = j / 3;
      const t2 = t * t;
      const t3 = t2 * t;
      const c0 = -0.5 * sm1 + 1.5 * s0 - 1.5 * s1 + 0.5 * s2;
      const c1 = sm1 - 2.5 * s0 + 2 * s1 - 0.5 * s2;
      const c2 = -0.5 * sm1 + 0.5 * s1;
      const c3 = s0;
      const interpolated = c0 * t3 + c1 * t2 + c2 * t + c3;
      const clamped = Math.max(-32768, Math.min(32767, Math.round(interpolated)));
      pcm16_24k.writeInt16LE(clamped, i * 6 + j * 2);
    }
  }
  
  return pcm16_24k;
}

function downsample24kTo8k(pcm16_24k) {
  const samplesIn = pcm16_24k.length / 2;
  const samplesOut = Math.floor(samplesIn / 3);
  const pcm16_8k = Buffer.alloc(samplesOut * 2);
  
  for (let i = 0; i < samplesOut; i++) {
    const sample = pcm16_24k.readInt16LE(i * 6);
    pcm16_8k.writeInt16LE(sample, i * 2);
  }
  
  return pcm16_8k;
}

/**
 * Setup WebSocket server for interview media streaming
 */
export function setupInterviewWebSocket(httpServer, publicUrl) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    
    if (pathname === '/interview-media') {
      console.log('[Interview-WS] 🔄 Handling WebSocket upgrade');
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
  });

  wss.on('connection', async (ws, req) => {
    console.log('[Interview-WS] ========== NEW INTERVIEW CONNECTION ==========');
    
    if (activeInterviewSockets.size >= 5) {
      console.warn('[Interview-WS] Too many active interviews');
      ws.close(1008, 'Too many active connections');
      return;
    }
    
    activeInterviewSockets.add(ws);
    
    let openaiWs = null;
    let streamSid = null;
    let interviewId = null;
    let interview = null;
    let currentQuestionIndex = 0;
    
    const connectionTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, 'Interview timeout');
      }
    }, 20 * 60 * 1000); // 20 minutes max

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.event === 'start') {
          streamSid = msg.start.streamSid;
          interviewId = msg.start.customParameters?.interviewId;
          
          console.log(`[Interview-WS] Stream started: ${streamSid}`);
          console.log(`[Interview-WS] Interview ID: ${interviewId}`);
          
          interview = interviewContextStore.get(interviewId) || scheduledInterviews.get(interviewId);
          
          if (!interview) {
            console.error('[Interview-WS] Interview not found');
            ws.close(1008, 'Interview not found');
            return;
          }
          
          // Initialize transcript
          interview.transcript = [];
          interview.status = 'in_progress';
          
          // Connect to OpenAI Realtime
          if (OPENAI_API_KEY) {
            openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime-2', {
              headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
              }
            });
            
            openaiWs.on('open', () => {
              console.log('[Interview-WS] ✅ OpenAI Realtime connected');
              
              // Configure session - use g711_ulaw for direct Twilio compatibility (no conversion!)
              openaiWs.send(JSON.stringify({
                type: 'session.update',
                session: {
                  modalities: ['audio', 'text'],
                  voice: 'alloy',
                  instructions: getInterviewInstructions(interview),
                  input_audio_format: 'g711_ulaw',  // Match Twilio's native format - no conversion!
                  output_audio_format: 'g711_ulaw', // Output directly in Twilio's format
                  input_audio_transcription: { model: 'whisper-1' },
                  turn_detection: {
                    type: 'server_vad',
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 700
                  }
                }
              }));
            });
            
            openaiWs.on('message', async (data) => {
              try {
                const msg = JSON.parse(data.toString());
                
                // After session is configured, trigger the initial greeting
                if (msg.type === 'session.updated') {
                  console.log('[Interview-WS] Session configured, triggering greeting...');
                  
                  // Send initial greeting prompt
                  openaiWs.send(JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                      type: 'message',
                      role: 'user',
                      content: [{
                        type: 'input_text',
                        text: `[System: The applicant ${interview.applicantName} has just answered the call. Start the interview with a warm, friendly greeting. Introduce yourself as Alex from HouseYield and explain you're calling about their rental application for ${interview.propertyAddress}. Ask if now is a good time to chat for about 10-15 minutes.]`
                      }]
                    }
                  }));
                  
                  // Trigger response generation
                  openaiWs.send(JSON.stringify({
                    type: 'response.create'
                  }));
                }
                
                // Handle audio responses - direct pass-through (g711_ulaw to Twilio)
                if (msg.type === 'response.audio.delta' && msg.delta) {
                  // OpenAI sends μ-law @ 8kHz directly - NO CONVERSION NEEDED!
                  const payload = msg.delta; // Already in base64 μ-law format
                  
                  if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                      event: 'media',
                      streamSid,
                      media: { payload }
                    }));
                  }
                }
                
                // Capture transcriptions for transcript
                if (msg.type === 'response.audio_transcript.done' && msg.transcript) {
                  interview.transcript.push({
                    speaker: 'AI',
                    text: msg.transcript,
                    timestamp: new Date().toISOString()
                  });
                }
                
                if (msg.type === 'conversation.item.input_audio_transcription.completed' && msg.transcript) {
                  interview.transcript.push({
                    speaker: 'Applicant',
                    text: msg.transcript,
                    timestamp: new Date().toISOString()
                  });
                }
                
                // Handle completion
                if (msg.type === 'response.done') {
                  console.log('[Interview-WS] Response complete');
                }
                
                // Log errors from OpenAI
                if (msg.type === 'error') {
                  console.error('[Interview-WS] OpenAI error:', msg.error);
                }
                
                // Debug logging for other message types
                if (!['response.audio.delta', 'input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped'].includes(msg.type)) {
                  console.log('[Interview-WS] OpenAI event:', msg.type);
                }
                
              } catch (e) {
                console.error('[Interview-WS] OpenAI message error:', e);
              }
            });
            
            openaiWs.on('error', (err) => {
              console.error('[Interview-WS] OpenAI error:', err);
            });
            
            openaiWs.on('close', () => {
              console.log('[Interview-WS] OpenAI connection closed');
            });
          }
        }
        
        // Handle incoming audio from Twilio - direct pass-through (g711_ulaw)
        if (msg.event === 'media' && msg.media?.payload && openaiWs?.readyState === WebSocket.OPEN) {
          // Direct pass-through - OpenAI accepts g711_ulaw natively!
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload  // Already in base64 μ-law format
          }));
        }
        
        // Handle stop
        if (msg.event === 'stop') {
          console.log('[Interview-WS] Stream stopped');
          
          if (interview) {
            interview.status = 'analyzing';
            interview.callEndedAt = new Date().toISOString();
            
            // Save to Firestore before analysis
            saveInterviewToFirestore(interview);
            
            // Trigger analysis
            setTimeout(() => {
              analyzeInterview(interviewId);
            }, 1000);
          }
        }
        
      } catch (e) {
        console.error('[Interview-WS] Message error:', e);
      }
    });

    ws.on('close', () => {
      console.log('[Interview-WS] Connection closed');
      activeInterviewSockets.delete(ws);
      clearTimeout(connectionTimeout);
      
      if (openaiWs?.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });

    ws.on('error', (err) => {
      console.error('[Interview-WS] Error:', err);
    });
  });

  console.log('✅ [Interview] WebSocket server ready');
}

// ===================================================================
// API FUNCTIONS
// ===================================================================

/**
 * Get all scheduled interviews for an owner (from cache + Firestore)
 */
export async function getScheduledInterviews(ownerId) {
  // First check in-memory cache
  const cached = Array.from(scheduledInterviews.values())
    .filter(i => i.ownerId === ownerId);
  
  // If cache has data, return it (Firestore is synced on updates)
  if (cached.length > 0) {
    return cached.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  
  // Otherwise load from Firestore
  const interviews = await loadOwnerInterviewsFromFirestore(ownerId);
  return interviews.filter(i => i.status !== 'completed' && i.status !== 'cancelled');
}

/**
 * Get all completed interviews for an owner (from cache + Firestore)
 */
export async function getCompletedInterviews(ownerId) {
  // First check in-memory cache
  const cached = Array.from(completedInterviews.values())
    .filter(i => i.ownerId === ownerId);
  
  if (cached.length > 0) {
    return cached.sort((a, b) => new Date(b.analyzedAt || b.createdAt) - new Date(a.analyzedAt || a.createdAt));
  }
  
  // Otherwise load from Firestore
  const interviews = await loadOwnerInterviewsFromFirestore(ownerId);
  return interviews.filter(i => i.status === 'completed');
}

/**
 * Get all interviews for an owner (both scheduled and completed)
 */
export async function getAllOwnerInterviews(ownerId) {
  const interviews = await loadOwnerInterviewsFromFirestore(ownerId);
  return interviews;
}

/**
 * Get all interviews for a property
 */
export async function getPropertyInterviews(propertyAddress) {
  return await loadPropertyInterviewsFromFirestore(propertyAddress);
}

/**
 * Get interview by ID (from cache or Firestore)
 */
export async function getInterview(interviewId) {
  // Check cache first
  const cached = scheduledInterviews.get(interviewId) || completedInterviews.get(interviewId);
  if (cached) return cached;
  
  // Load from Firestore
  return await loadInterviewFromFirestore(interviewId);
}

/**
 * Get interview by booking token
 */
export function getInterviewByToken(bookingToken) {
  return Array.from(scheduledInterviews.values()).find(i => i.bookingToken === bookingToken);
}

/**
 * Cancel an interview
 */
export async function cancelInterview(interviewId) {
  const interview = scheduledInterviews.get(interviewId);
  if (!interview) {
    return { ok: false, error: 'Interview not found' };
  }
  
  interview.status = 'cancelled';
  interview.cancelledAt = new Date().toISOString();
  
  // Save cancellation to Firestore
  await saveInterviewToFirestore(interview);
  
  return { ok: true };
}

/**
 * Get system status
 */
export function getInterviewSystemStatus() {
  return {
    configured: !!(twilioClient && OPENAI_API_KEY),
    twilioReady: !!twilioClient,
    openaiReady: !!OPENAI_API_KEY,
    activeInterviews: activeInterviewSockets.size,
    scheduledCount: scheduledInterviews.size,
    completedCount: completedInterviews.size,
    fromNumber: TWILIO_FROM_NUMBER || 'Not configured'
  };
}

// Export everything
export {
  scheduledInterviews,
  completedInterviews,
  interviewContextStore,
  DEFAULT_INTERVIEW_QUESTIONS,
  loadOwnerInterviewsFromFirestore,
  loadPropertyInterviewsFromFirestore,
  loadInterviewFromFirestore,
  saveInterviewToFirestore
};
