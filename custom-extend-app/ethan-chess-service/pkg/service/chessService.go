package service

import (
	"context"
	"log"
	"strings"

	"github.com/junaili/ethan-chess-service/pkg/handler"
	pb "github.com/junaili/ethan-chess-service/pkg/pb"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type ChessServiceServer struct {
	pb.UnimplementedChessServiceServer
}

func NewChessServiceServer() *ChessServiceServer {
	return &ChessServiceServer{}
}

func (s *ChessServiceServer) SendInvite(_ context.Context, req *pb.SendInviteRequest) (*pb.SendInviteResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "request is required")
	}

	invite := handler.InviteRequest{
		To:         req.To,
		FromName:   req.FromName,
		InviteLink: req.InviteLink,
	}
	if err := handler.ValidateInviteRequest(invite); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if err := handler.SendInviteEmail(invite); err != nil {
		log.Printf("[service] email delivery failed: %v", err)
		return nil, status.Error(codes.Internal, "email delivery failed")
	}

	return &pb.SendInviteResponse{Ok: true}, nil
}

func (s *ChessServiceServer) LookupByEmail(_ context.Context, req *pb.LookupByEmailRequest) (*pb.LookupByEmailResponse, error) {
	if req == nil {
		return nil, status.Error(codes.InvalidArgument, "request is required")
	}
	email := strings.TrimSpace(req.Email)
	if err := handler.ValidateEmailAddress(email); err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "valid email required")
	}

	result, err := handler.LookupEmailInIAM(email)
	if err != nil {
		log.Printf("[service] IAM lookup failed: %v", err)
		return nil, status.Error(codes.Internal, "lookup failed")
	}

	return &pb.LookupByEmailResponse{
		Found:       result.Found,
		UserId:      result.UserID,
		DisplayName: result.DisplayName,
	}, nil
}
