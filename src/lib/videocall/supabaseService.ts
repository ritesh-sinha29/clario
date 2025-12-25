// Supabase Database Service
import { supabase } from './supabaseClient';

export interface Room {
  id: string;
  mentor_id: string;
  duration_minutes: number;
  status: 'active' | 'ended';
  created_at: string;
  updated_at: string;
  ended_at?: string;
}

export interface ChatMessage {
  id: string;
  room_id: string;
  user_id: string;
  user_name?: string;
  message: string;
  created_at: string;
  updated_at: string;
}

export interface Signal {
  id: string;
  room_id: string;
  sender_id: string;
  receiver_id?: string;
  signal_type: 'offer' | 'answer' | 'ice';
  signal_data: any;
  created_at: string;
}

export interface TypingStatus {
  id: string;
  room_id: string;
  user_id: string;
  user_name?: string;
  is_typing: boolean;
  updated_at: string;
}

export class SupabaseService {
  /**
   * Create a new room
   */
  static async createRoom(mentorId: string, durationMinutes: number): Promise<Room> {
    const { data, error } = await supabase
      .from('rooms')
      .insert([
        {
          mentor_id: mentorId,
          duration_minutes: durationMinutes,
          status: 'active',
        },
      ])
      .select()
      .single();

    if (error) throw new Error(`Failed to create room: ${error.message}`);
    return data as Room;
  }

  /**
   * Get room by ID
   */
  static async getRoom(roomId: string): Promise<Room> {
    const { data, error } = await supabase.from('rooms').select('*').eq('id', roomId);

    if (error) throw new Error(`Failed to fetch room: ${error.message}`);
    if (!data || data.length === 0) throw new Error(`Room ${roomId} not found`);
    return data[0] as Room;
  }

  /**
   * Update room status
   */
  static async updateRoomStatus(roomId: string, status: 'active' | 'ended'): Promise<void> {
    const { error } = await supabase
      .from('rooms')
      .update({ status, updated_at: new Date().toISOString(), ended_at: status === 'ended' ? new Date().toISOString() : null })
      .eq('id', roomId);

    if (error) throw new Error(`Failed to update room: ${error.message}`);
  }

  /**
   * Store WebRTC signal
   */
  static async storeSignal(signal: Omit<Signal, 'id' | 'created_at'>): Promise<Signal> {
    const { data, error } = await supabase
      .from('signals')
      .insert([signal])
      .select()
      .single();

    if (error) throw new Error(`Failed to store signal: ${error.message}`);
    return data as Signal;
  }

  /**
   * Get signals for a room
   */
  static async getSignals(roomId: string): Promise<Signal[]> {
    // Only get signals from the last 2 minutes to avoid processing stale candidates
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('signals')
      .select('*')
      .eq('room_id', roomId)
      .gte('created_at', twoMinutesAgo)
      .order('created_at', { ascending: true });

    if (error) throw new Error(`Failed to fetch signals: ${error.message}`);
    return data as Signal[];
  }

  /**
   * Send chat message
   */
  static async sendMessage(message: Omit<ChatMessage, 'id' | 'created_at' | 'updated_at'>): Promise<ChatMessage> {
    const { data, error } = await supabase
      .from('chat_messages')
      .insert([message])
      .select()
      .single();

    if (error) throw new Error(`Failed to send message: ${error.message}`);
    return data as ChatMessage;
  }

  /**
   * Get chat history for a room
   */
  static async getChatHistory(roomId: string): Promise<ChatMessage[]> {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('room_id', roomId)
      .order('created_at', { ascending: true });

    if (error) throw new Error(`Failed to fetch chat history: ${error.message}`);
    return data as ChatMessage[];
  }

  /**
   * Subscribe to signals in real-time
   */
  static subscribeToSignals(roomId: string, callback: (signal: Signal) => void) {
    return supabase
      .channel(`signals-${roomId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'signals',
          filter: `room_id=eq.${roomId}`,
        },
        (payload: any) => {
          callback(payload.new as Signal);
        }
      )
      .subscribe();
  }

  /**
   * Subscribe to chat messages in real-time
   */
  static subscribeToChat(roomId: string, callback: (message: ChatMessage) => void) {
    return supabase
      .channel(`chat-${roomId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chat_messages',
          filter: `room_id=eq.${roomId}`,
        },
        (payload: any) => {
          callback(payload.new as ChatMessage);
        }
      )
      .subscribe();
  }

  /**
   * Update typing status
   */
  static async updateTypingStatus(roomId: string, userId: string, isTyping: boolean, userName?: string): Promise<void> {
    const { error } = await supabase.from('typing_status').upsert(
      [
        {
          room_id: roomId,
          user_id: userId,
          is_typing: isTyping,
          user_name: userName,
          updated_at: new Date().toISOString(),
        },
      ],
      { onConflict: 'room_id,user_id' }
    );

    if (error) throw new Error(`Failed to update typing status: ${error.message}`);
  }

  /**
   * Subscribe to typing status changes
   */
  static subscribeToTypingStatus(roomId: string, callback: (status: TypingStatus) => void) {
    return supabase
      .channel(`typing-${roomId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'typing_status',
          filter: `room_id=eq.${roomId}`,
        },
        (payload: any) => {
          callback(payload.new as TypingStatus);
        }
      )
      .subscribe();
  }

  /**
   * Clean up a room (remove all related data)
   */
  static async cleanupRoom(roomId: string): Promise<void> {
    const { error: signalsError } = await supabase.from('signals').delete().eq('room_id', roomId);
    const { error: messagesError } = await supabase.from('chat_messages').delete().eq('room_id', roomId);
    const { error: typingError } = await supabase.from('typing_status').delete().eq('room_id', roomId);
    const { error: roomError } = await supabase.from('rooms').delete().eq('id', roomId);

    if (signalsError || messagesError || typingError || roomError) {
      throw new Error('Failed to cleanup room');
    }
  }
}
