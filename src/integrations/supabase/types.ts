export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      app_settings: {
        Row: {
          data: Json
          updated_at: string
          workspace_id: string
        }
        Insert: {
          data?: Json
          updated_at?: string
          workspace_id: string
        }
        Update: {
          data?: Json
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_settings_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: true
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      checkout_jobs: {
        Row: {
          created_at: string
          error: string | null
          id: string
          input: Json
          phase: string
          phase_attempts: number
          result: Json | null
          session: Json | null
          stage: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          error?: string | null
          id?: string
          input?: Json
          phase?: string
          phase_attempts?: number
          result?: Json | null
          session?: Json | null
          stage?: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          error?: string | null
          id?: string
          input?: Json
          phase?: string
          phase_attempts?: number
          result?: Json | null
          session?: Json | null
          stage?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      checkout_profiles: {
        Row: {
          created_at: string
          data: Json
          id: string
          is_active: boolean
          name: string
          position: number
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          data?: Json
          id?: string
          is_active?: boolean
          name: string
          position?: number
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          data?: Json
          id?: string
          is_active?: boolean
          name?: string
          position?: number
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "checkout_profiles_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      proxy_groups: {
        Row: {
          created_at: string
          id: string
          name: string
          position: number
          proxies: string[]
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          position?: number
          proxies?: string[]
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          position?: number
          proxies?: string[]
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "proxy_groups_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      runner_devices: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          last_seen_at: string
          name: string
          token: string
          workspace_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          last_seen_at?: string
          name?: string
          token: string
          workspace_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          last_seen_at?: string
          name?: string
          token?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "runner_devices_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      runner_jobs: {
        Row: {
          claimed: boolean
          created_at: string
          device_id: string
          dry_run: boolean
          id: string
          payload: Json
          store_url: string
        }
        Insert: {
          claimed?: boolean
          created_at?: string
          device_id: string
          dry_run?: boolean
          id: string
          payload: Json
          store_url: string
        }
        Update: {
          claimed?: boolean
          created_at?: string
          device_id?: string
          dry_run?: boolean
          id?: string
          payload?: Json
          store_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "runner_jobs_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "runner_devices"
            referencedColumns: ["id"]
          },
        ]
      }
      runner_pairing_codes: {
        Row: {
          code: string
          created_at: string
          device_name: string
          workspace_id: string | null
        }
        Insert: {
          code: string
          created_at?: string
          device_name?: string
          workspace_id?: string | null
        }
        Update: {
          code?: string
          created_at?: string
          device_name?: string
          workspace_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "runner_pairing_codes_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      runner_results: {
        Row: {
          created_at: string
          error: string | null
          job_id: string
          ok: boolean
          order_id: string | null
          payload: Json
        }
        Insert: {
          created_at?: string
          error?: string | null
          job_id: string
          ok: boolean
          order_id?: string | null
          payload: Json
        }
        Update: {
          created_at?: string
          error?: string | null
          job_id?: string
          ok?: boolean
          order_id?: string | null
          payload?: Json
        }
        Relationships: [
          {
            foreignKeyName: "runner_results_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "runner_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      stores: {
        Row: {
          created_at: string
          id: string
          name: string
          position: number
          url: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          position?: number
          url: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          position?: number
          url?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stores_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          created_at: string
          data: Json
          id: string
          status: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          data?: Json
          id?: string
          status?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          data?: Json
          id?: string
          status?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tasks_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_activation_codes: {
        Row: {
          code: string
          created_at: string
          workspace_id: string
        }
        Insert: {
          code: string
          created_at?: string
          workspace_id: string
        }
        Update: {
          code?: string
          created_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_activation_codes_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspace_devices: {
        Row: {
          created_at: string
          id: string
          last_seen_at: string
          name: string
          token_hash: string
          user_agent: string | null
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_seen_at?: string
          name?: string
          token_hash: string
          user_agent?: string | null
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          last_seen_at?: string
          name?: string
          token_hash?: string
          user_agent?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_devices_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          id: string
          recovery_code_hash: string
        }
        Insert: {
          created_at?: string
          id?: string
          recovery_code_hash: string
        }
        Update: {
          created_at?: string
          id?: string
          recovery_code_hash?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      request_checkout_worker: {
        Args: { p_job_id: string; p_token: string; p_url: string }
        Returns: number
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
