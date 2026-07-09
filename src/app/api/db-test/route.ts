import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "../../../db";

export async function GET() {
  try {
    const result = await db.execute(sql`SELECT NOW() as current_time`);

    return NextResponse.json({
      success: true,
      message: "Database connected successfully",
      data: result,
    });
    
  } catch (error) {
    console.error("DB connection error:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Database connection failed",
      },
      { status: 500 }
    );
  }
}