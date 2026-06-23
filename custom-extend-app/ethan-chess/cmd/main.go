package main

import (
	"log"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"

	"github.com/junaili/ethan-chess/pkg/handler"
	"github.com/junaili/ethan-chess/pkg/middleware"
)

func main() {
	// Load .env for local development; silently ignored in production
	_ = godotenv.Load()

	requiredEnv := []string{"GMAIL_USER", "GMAIL_APP_PW"}
	for _, key := range requiredEnv {
		if os.Getenv(key) == "" {
			log.Fatalf("required environment variable %s is not set", key)
		}
	}

	auth := middleware.NewAGSAuth(
		os.Getenv("AB_BASE_URL"),
		os.Getenv("AB_CLIENT_ID"),
		os.Getenv("AB_CLIENT_SECRET"),
	)

	r := gin.Default()

	r.Use(func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", "*")
		c.Header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "Authorization, Content-Type")
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	})

	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok"})
	})

	api := r.Group("/", auth.Validate())
	{
		api.POST("/invite/email", handler.SendInvite)
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("ethan-chess email service listening on :%s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatal(err)
	}
}
