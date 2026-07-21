ALTER TABLE "document_chunks" ADD COLUMN "embedding" vector(1024);--> statement-breakpoint
CREATE INDEX "document_chunks_embedding_idx" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);